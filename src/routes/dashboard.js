'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { actionItems } = require('../lib/actions');
const { todayStr, toDate, now, ago } = require('../lib/util');

const r = express.Router();

async function topicProgress(ids) {
  if (!ids.length) return [];
  const topics = await db('topics').whereIn('id', ids).whereNot('status', 'archived').orderBy('id', 'desc');
  const counts = await db('tasks').whereIn('topic_id', ids).groupBy('topic_id', 'status').select('topic_id', 'status').count({ n: '*' });
  return topics.map((t) => {
    const mine = counts.filter((c) => c.topic_id === t.id);
    const total = mine.reduce((a, c) => a + Number(c.n), 0);
    const done = mine.filter((c) => c.status === 'done').reduce((a, c) => a + Number(c.n), 0);
    return { ...t, total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  });
}

r.get('/', async (req, res) => {
  const me = req.user;
  const ids = await auth.myTopicIds(me);
  const myTasks = await db('tasks').join('topics', 'topics.id', 'tasks.topic_id').where('tasks.assignee_id', me.id).whereNot('tasks.status', 'done')
    .orderByRaw('case when tasks.due_date is null then 1 else 0 end').orderBy('tasks.due_date').limit(8)
    .select('tasks.*', 'topics.code', 'topics.title as topic_title');
  const wids = await auth.workTopicIds(me);
  const meetings = wids.length ? await db('meetings').join('topics', 'topics.id', 'meetings.topic_id').whereIn('meetings.topic_id', wids).where('meetings.starts_at', '>=', new Date(Date.now() - 3600000).toISOString())
    .orderBy('meetings.starts_at').limit(4).select('meetings.*', 'topics.code') : [];
  const progress = await topicProgress(ids);
  // Tasks completed per week, last 8 weeks
  const since = new Date(Date.now() - 56 * 86400000);
  const done = ids.length ? await db('tasks').whereIn('topic_id', ids).where('status', 'done').whereNotNull('completed_at').select('completed_at') : [];
  const weeks = Array.from({ length: 8 }, (_, i) => ({ n: 0, label: 'W' + (i + 1) }));
  for (const t of done) {
    const d = toDate(t.completed_at);
    if (!d || d < since) continue;
    const w = Math.min(7, Math.floor((d - since) / (7 * 86400000)));
    weeks[w].n++;
  }
  weeks[7].label = 'This wk';
  const max = Math.max(1, ...weeks.map((w) => w.n));
  const activity = wids.length ? await db('audit_log').leftJoin('users', 'users.id', 'audit_log.user_id').leftJoin('topics', 'topics.id', 'audit_log.topic_id')
    .whereIn('audit_log.topic_id', wids).orderBy('audit_log.id', 'desc').limit(7).select('audit_log.*', 'users.name', 'users.color', 'users.id as uid', 'topics.code') : [];
  const actions = await actionItems(me);
  const weekEnd = todayStr(7);
  const dueSoon = await db('tasks').where({ assignee_id: me.id }).whereNot('status', 'done').where('due_date', '<=', weekEnd).count({ n: '*' }).first();
  res.render('pages/dashboard', {
    title: 'Dashboard', active: 'dashboard', myTasks, meetings, progress, weeks, max, activity, actions: actions.slice(0, 4), actionTotal: actions.length,
    stats: { topics: progress.length, dueSoon: Number(dueSoon.n), meetings: meetings.length, actions: actions.length },
    hour: Number(new Date().toLocaleString('en-AU', { hour: 'numeric', hour12: false, timeZone: 'Australia/Sydney' })),
    cta: auth.atLeast(me, 'leader') ? { href: '/topics/new', label: 'New topic' } : null
  });
});

r.get('/tasks', async (req, res) => {
  const filter = ['open', 'done', 'all'].includes(req.query.show) ? req.query.show : 'open';
  let q = db('tasks').join('topics', 'topics.id', 'tasks.topic_id').where('tasks.assignee_id', req.user.id);
  if (filter === 'open') q = q.whereNot('tasks.status', 'done');
  if (filter === 'done') q = q.where('tasks.status', 'done');
  const tasks = await q.orderByRaw('case when tasks.due_date is null then 1 else 0 end').orderBy('tasks.due_date').select('tasks.*', 'topics.code', 'topics.title as topic_title');
  res.render('pages/tasks', { title: 'My tasks', active: 'tasks', tasks, filter });
});

r.get('/actions', async (req, res) => {
  const items = await actionItems(req.user);
  const type = req.query.type || 'All';
  res.render('pages/actions', { title: 'Action centre', active: 'actions', items: type === 'All' ? items : items.filter((i) => i.type === type), all: items, type });
});

r.get('/notifications', async (req, res) => {
  const show = req.query.show === 'unread' ? 'unread' : 'all';
  let q = db('notifications').where({ user_id: req.user.id });
  if (show === 'unread') q = q.whereNull('read_at');
  const list = await q.orderBy('id', 'desc').limit(100);
  res.render('pages/notifications', { title: 'Notifications', active: 'notifications', list, show });
});
r.post('/notifications/read-all', async (req, res) => {
  await db('notifications').where({ user_id: req.user.id }).whereNull('read_at').update({ read_at: now() });
  res.redirect('/notifications');
});
r.get('/notifications/:id/go', async (req, res) => {
  const n = await db('notifications').where({ id: parseInt(req.params.id, 10), user_id: req.user.id }).first();
  if (!n) return auth.notFound(res);
  if (!n.read_at) await db('notifications').where({ id: n.id }).update({ read_at: now() });
  const link = n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : '/notifications';
  res.redirect(link);
});

r.get('/meetings', async (req, res) => {
  const ids = await auth.workTopicIds(req.user);
  const all = ids.length ? await db('meetings').join('topics', 'topics.id', 'meetings.topic_id').whereIn('meetings.topic_id', ids).orderBy('meetings.starts_at').select('meetings.*', 'topics.code', 'topics.title as topic_title') : [];
  const cut = Date.now() - 3600000;
  res.render('pages/meetings-all', { title: 'Meetings', active: 'meetings', upcoming: all.filter((m) => toDate(m.starts_at) >= cut), past: all.filter((m) => toDate(m.starts_at) < cut).reverse() });
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
