'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { actionItems } = require('../lib/actions');
const { journeyMany } = require('../lib/journey');
const { todayStr, toDate, now, ago } = require('../lib/util');

const r = express.Router();

async function topicProgress(ids) {
  if (!ids.length) return [];
  const topics = await db('topics').whereIn('id', ids).whereNot('status', 'archived').orderBy('id', 'desc');
  const counts = await db('tasks').whereIn('topic_id', ids).groupBy('topic_id', 'status').select('topic_id', 'status').count({ n: '*' });
  const pc = await db('parts').whereIn('topic_id', ids).groupBy('topic_id', 'agent_status').select('topic_id', 'agent_status').count({ n: '*' });
  return topics.map((t) => {
    // Progress = parts whose agent findings are accepted; topics without parts fall back to board tasks.
    const parts = pc.filter((c) => c.topic_id === t.id);
    if (parts.length) {
      const total = parts.reduce((a, c) => a + Number(c.n), 0);
      const done = parts.filter((c) => c.agent_status === 'accepted').reduce((a, c) => a + Number(c.n), 0);
      return { ...t, total, done, unit: 'parts', pct: total ? Math.round((done / total) * 100) : 0 };
    }
    const mine = counts.filter((c) => c.topic_id === t.id);
    const total = mine.reduce((a, c) => a + Number(c.n), 0);
    const done = mine.filter((c) => c.status === 'done').reduce((a, c) => a + Number(c.n), 0);
    return { ...t, total, done, unit: 'tasks', pct: total ? Math.round((done / total) * 100) : 0 };
  });
}

r.get('/', async (req, res) => {
  const me = req.user;
  const ids = await auth.myTopicIds(me);
  const show = req.query.show === 'finished' ? 'finished' : 'active';
  const topics = ids.length ? await db('topics').whereIn('id', ids).whereNot('status', 'archived').orderBy('id', 'desc') : [];
  const roles = Object.fromEntries((await db('topic_members').where({ user_id: me.id }).select('topic_id', 'role')).map((x) => [x.topic_id, x.role]));
  if (me.platform_role === 'admin') for (const t of topics) roles[t.id] = roles[t.id] || 'leader';
  const js = await journeyMany(topics, roles);
  const team = topics.length ? await db('topic_members').join('users', 'users.id', 'topic_members.user_id').whereIn('topic_members.topic_id', topics.map((t) => t.id)).whereNot('topic_members.role', 'guest')
    .orderByRaw("case topic_members.role when 'leader' then 0 else 1 end").select('topic_members.topic_id', 'users.id', 'users.name', 'users.color') : [];
  const list = topics.map((t) => ({ ...t, j: js[t.id], role: roles[t.id], team: team.filter((m) => m.topic_id === t.id) }));
  const active = list.filter((t) => t.status !== 'completed');
  const finished = list.filter((t) => t.status === 'completed');
  // Up next: the most useful next step from each project you lead.
  const rank = (n) => (/Review/.test(n.label || '') ? 0 : /Launch|Assign/.test(n.label || '') ? 1 : /writ/i.test(n.label || '') ? 2 : /Finish/.test(n.label || '') ? 3 : 5);
  const upNext = active.filter((t) => t.j.next && (t.j.next.href || t.j.next.action) && t.role !== 'guest')
    .map((t) => ({ topic: t, next: t.j.next, step: t.j.current ? t.j.current.n : null, r: rank(t.j.next) + (t.role === 'leader' ? 0 : 4) }))
    .sort((a, b) => a.r - b.r).slice(0, 3);
  const actions = await actionItems(me);
  res.render('pages/dashboard', {
    title: 'Home', active: 'dashboard', show, projects: show === 'finished' ? finished : active, nActive: active.length, nFinished: finished.length, upNext, needCount: actions.length,
    hour: Number(new Date().toLocaleString('en-AU', { hour: 'numeric', hour12: false, timeZone: 'Australia/Sydney' })),
    tipsKey: 'home'
  });
});

r.get('/help', (req, res) => res.render('pages/help', { title: 'Help', active: 'help' }));

r.get('/tasks', async (req, res) => {
  const filter = ['open', 'done', 'all'].includes(req.query.show) ? req.query.show : 'open';
  let q = db('tasks').join('topics', 'topics.id', 'tasks.topic_id').where('tasks.assignee_id', req.user.id);
  if (filter === 'open') q = q.whereNot('tasks.status', 'done');
  if (filter === 'done') q = q.where('tasks.status', 'done');
  const tasks = await q.orderByRaw('case when tasks.due_date is null then 1 else 0 end').orderBy('tasks.due_date').select('tasks.*', 'topics.code', 'topics.title as topic_title');
  res.render('pages/tasks', { title: 'My tasks', active: 'tasks', tasks, filter });
});

// One Inbox: what needs you, plus messages, mentions, meetings and updates.
const INBOX_KIND = { message: 'message', mention: 'mention', meeting: 'meeting', room: 'meeting' };
const inboxKind = (k) => INBOX_KIND[k] || 'update';
r.get('/inbox', async (req, res) => {
  const f = ['all', 'needs', 'message', 'mention', 'meeting', 'update'].includes(req.query.f) ? req.query.f : 'all';
  const needs = await actionItems(req.user);
  const notes = (await db('notifications').where({ user_id: req.user.id }).orderBy('id', 'desc').limit(80)).map((n) => ({ ...n, k: inboxKind(n.kind) }));
  const counts = { all: needs.length + notes.length, needs: needs.length };
  for (const k of ['message', 'mention', 'meeting', 'update']) counts[k] = notes.filter((n) => n.k === k).length;
  const rows = f === 'all' || f === 'needs' ? notes : notes.filter((n) => n.k === f);
  const wids = await auth.workTopicIds(req.user);
  const meetings = wids.length ? await db('meetings').join('topics', 'topics.id', 'meetings.topic_id').whereIn('meetings.topic_id', wids)
    .where('meetings.starts_at', '>=', new Date(Date.now() - 3600000).toISOString()).where('meetings.starts_at', '<=', new Date(Date.now() + 7 * 86400000).toISOString())
    .orderBy('meetings.starts_at').limit(4).select('meetings.*', 'topics.title as topic_title', 'topics.color as topic_color') : [];
  const todayKey = new Date().toLocaleDateString('en-AU', { timeZone: require('../lib/util').TZ });
  res.render('pages/inbox', { title: 'Inbox', active: 'inbox', f, needs, rows: f === 'needs' ? rows.slice(0, 10) : rows, counts, meetings, todayKey, unreadCount: notes.filter((n) => !n.read_at).length });
});
r.get('/actions', (req, res) => res.redirect('/inbox?f=needs'));
r.get('/notifications', (req, res) => res.redirect('/inbox'));
r.post('/notifications/read-all', async (req, res) => {
  await db('notifications').where({ user_id: req.user.id }).whereNull('read_at').update({ read_at: now() });
  req.flash('ok', 'All marked as read.');
  res.redirect('/inbox');
});
r.post('/notifications/clear-read', async (req, res) => {
  const n = await db('notifications').where({ user_id: req.user.id }).whereNotNull('read_at').del();
  req.flash('ok', n ? 'Cleared ' + n + ' read notification' + (n === 1 ? '' : 's') + '.' : 'Nothing to clear.');
  res.redirect('/inbox');
});
r.post('/notifications/:id/delete', async (req, res) => {
  await db('notifications').where({ id: parseInt(req.params.id, 10), user_id: req.user.id }).del();
  res.redirect('/inbox');
});
r.get('/notifications/:id/go', async (req, res) => {
  const n = await db('notifications').where({ id: parseInt(req.params.id, 10), user_id: req.user.id }).first();
  if (!n) return auth.notFound(res);
  if (!n.read_at) await db('notifications').where({ id: n.id }).update({ read_at: now() });
  const link = n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : '/inbox';
  res.redirect(link);
});

r.get('/meetings', async (req, res) => {
  const ids = await auth.workTopicIds(req.user);
  const all = ids.length ? await db('meetings').join('topics', 'topics.id', 'meetings.topic_id').whereIn('meetings.topic_id', ids).orderBy('meetings.starts_at').select('meetings.*', 'topics.code', 'topics.title as topic_title') : [];
  const cut = Date.now() - 3600000;
  // Rooms you can join, grouped by topic (non-archived topics only)
  const topics = ids.length ? await db('topics').whereIn('id', ids).whereNot('status', 'archived').orderBy('id', 'desc') : [];
  const roleOf = Object.fromEntries((await db('topic_members').where({ user_id: req.user.id }).select('topic_id', 'role')).map((x) => [x.topic_id, x.role]));
  const roomGroups = [];
  for (const t of topics) {
    const list = await require('../lib/rooms').roomsFor(t, req.user, req.user.platform_role === 'admin' ? 'leader' : roleOf[t.id]);
    roomGroups.push({ topic: t, rooms: list.filter((r) => r.kind === 'project' || r.people.some((p) => p.id === req.user.id)) });
  }
  res.render('pages/meetings-all', { title: 'Meetings', active: 'inbox', roomGroups, upcoming: all.filter((m) => toDate(m.starts_at) >= cut), past: all.filter((m) => toDate(m.starts_at) < cut).reverse() });
});

r.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const ids = await auth.myTopicIds(req.user);
  const wids = await auth.workTopicIds(req.user);
  const results = [];
  if (q && ids.length) {
    const like = '%' + q.toLowerCase() + '%';
    const L = (col) => db.raw('lower(' + col + ') like ?', [like]);
    for (const t of await db('topics').whereIn('id', ids).where((w) => w.where(L('title')).orWhere(L('code')).orWhere(L("coalesce(description, '')"))).limit(10)) results.push({ type: 'Topic', title: t.title, meta: t.code, href: '/topics/' + t.id, c: 'burgundy' });
    for (const t of await db('tasks').join('topics', 'topics.id', 'tasks.topic_id').whereIn('tasks.topic_id', wids.length ? wids : [0]).where(L('tasks.title')).limit(10).select('tasks.title', 'tasks.topic_id', 'topics.code')) results.push({ type: 'Task', title: t.title, meta: t.code, href: '/topics/' + t.topic_id + '/board', c: 'indigo' });
    for (const f of await db('files').join('topics', 'topics.id', 'files.topic_id').whereIn('files.topic_id', ids).where(L('files.name')).limit(10).select('files.id', 'files.name', 'files.topic_id', 'topics.code')) results.push({ type: 'File', title: f.name, meta: f.code, href: '/topics/' + f.topic_id + '/files', c: 'teal' });
    for (const m of await db('messages').join('channels', 'channels.id', 'messages.channel_id').leftJoin('users', 'users.id', 'messages.user_id').whereIn('channels.topic_id', wids.length ? wids : [0]).where(L('messages.body')).orderBy('messages.id', 'desc').limit(10).select('messages.body', 'channels.id as cid', 'channels.name', 'users.name as who', 'messages.created_at')) results.push({ type: 'Message', title: m.who + ' in #' + m.name, meta: m.body.slice(0, 140), href: '/messages/' + m.cid, c: 'amber' });
    for (const p of await db('users').where('status', 'active').where((w) => w.where(L('name')).orWhere(L("coalesce(title, '')"))).limit(10)) results.push({ type: 'Person', title: p.name, meta: p.title || '', href: '/people/' + p.id, c: 'violet' });
  }
  res.render('pages/search', { title: 'Search', active: '', q, results });
});

module.exports = r;
module.exports.topicProgress = topicProgress;
module.exports.ago = ago;
