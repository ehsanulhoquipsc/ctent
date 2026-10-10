'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit } = require('../lib/events');
const { now, matchScore, detectPlatform, safeUrl, toDate } = require('../lib/util');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const validDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
const STATUSES = ['todo', 'doing', 'review', 'done'];
const crumb = (t, label) => '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / ' + label;

// Archived topics are read-only.
function writable(req, res, next) {
  if (req.topic.status === 'archived') { req.flash('error', 'This topic is archived and read-only. A leader can reopen it in Settings.'); return res.redirect('/topics/' + req.topic.id); }
  next();
}

async function members(topicId, includeGuests) {
  let q = db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', topicId);
  if (!includeGuests) q = q.whereNot('topic_members.role', 'guest');
  return q.orderBy('users.name').select('users.id', 'users.name', 'users.color', 'users.title', 'topic_members.role');
}

// ================= Plan & assign =================
r.get('/topics/:tid/plan', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const people = await members(t.id, false);
  const exp = people.length ? await db('expertise').whereIn('user_id', people.map((p) => p.id)) : [];
  const load = Object.fromEntries((await db('tasks').where({ topic_id: t.id }).whereNot('status', 'done').groupBy('assignee_id').select('assignee_id').count({ n: '*' })).map((x) => [x.assignee_id, Number(x.n)]));
  const parts = await db('parts').where({ topic_id: t.id }).orderBy('id');
  const taskCounts = Object.fromEntries((await db('tasks').where({ topic_id: t.id }).whereNotNull('part_id').groupBy('part_id').select('part_id').count({ n: '*' })).map((x) => [x.part_id, Number(x.n)]));
  const view = parts.map((p) => {
    const suggestions = people.map((m) => ({ ...m, score: matchScore(p.skills, exp.filter((e) => e.user_id === m.id)), load: load[m.id] || 0 })).sort((a, b) => b.score - a.score || a.load - b.load);
    return { ...p, suggestions, owner: people.find((m) => m.id === p.proposed_user_id) || null, tasks: taskCounts[p.id] || 0 };
  });
  res.render('pages/plan', { title: 'Plan & assign · ' + t.code, active: 'topics', tab: 'Plan & assign', crumb: crumb(t, 'Plan & assign'), parts: view, people, load });
});
r.post('/topics/:tid/plan', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title);
  if (title.length < 3) { req.flash('error', 'Give the part a title.'); return res.redirect('/topics/' + t.id + '/plan'); }
  await db('parts').insert({ topic_id: t.id, title, description: clean(req.body.description, 1000), skills: clean(req.body.skills, 400), due_date: validDate(req.body.due_date), status: 'open', created_at: now() });
  await audit(req.user.id, t.id, 'part.created', 'Added part “' + title + '”');
  req.flash('ok', 'Part added. Pick an owner and approve it.');
  res.redirect('/topics/' + t.id + '/plan');
});
// Leader proposes/changes the owner and approves. Nothing is auto-assigned.
r.post('/topics/:tid/plan/:pid', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const part = await db('parts').where({ id: parseInt(req.params.pid, 10), topic_id: t.id }).first();
  if (!part) return auth.notFound(res);
  const action = req.body.action;
  if (action === 'delete') {
    await db('parts').where({ id: part.id }).del();
    await audit(req.user.id, t.id, 'part.deleted', 'Deleted part “' + part.title + '”');
    req.flash('ok', 'Part deleted.');
    return res.redirect('/topics/' + t.id + '/plan');
  }
  const uid = parseInt(req.body.user_id_other, 10) || parseInt(req.body.user_id, 10) || null;
  if (uid && !(await db('topic_members').where({ topic_id: t.id, user_id: uid }).whereNot('role', 'guest').first())) { req.flash('error', 'Owners must be members of this topic.'); return res.redirect('/topics/' + t.id + '/plan'); }
  if (action === 'approve') {
    if (!uid) { req.flash('error', 'Choose who will own this part before approving.'); return res.redirect('/topics/' + t.id + '/plan'); }
    const person = await db('users').where({ id: uid }).first();
    await db('parts').where({ id: part.id }).update({ proposed_user_id: uid, status: 'approved', approved_by: req.user.id });
    const has = await db('tasks').where({ part_id: part.id }).first();
    if (!has) await db('tasks').insert({ topic_id: t.id, part_id: part.id, title: part.title, description: part.description, status: 'todo', priority: 'normal', assignee_id: uid, due_date: part.due_date, created_by: req.user.id, created_at: now(), updated_at: now() });
    else await db('tasks').where({ part_id: part.id }).whereNot('status', 'done').update({ assignee_id: uid, updated_at: now() });
    await notify(uid, { kind: 'task', title: 'You were approved for “' + part.title + '”', body: t.code + ' · ' + t.title, link: '/topics/' + t.id + '/board' }, req.user.id);
    await audit(req.user.id, t.id, 'part.approved', 'Approved ' + person.name + ' for “' + part.title + '”');
    req.flash('ok', person.name + ' approved for “' + part.title + '”. A task was added to the board.');
  } else {
    await db('parts').where({ id: part.id }).update({ proposed_user_id: uid, status: 'open', approved_by: null });
    req.flash('ok', 'Owner saved as a proposal. Approve it when you’re ready.');
  }
  res.redirect('/topics/' + t.id + '/plan');
});

// ================= Board =================
r.get('/topics/:tid/board', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const who = req.query.who === 'me' ? req.user.id : parseInt(req.query.who, 10) || null;
  let q = db('tasks').leftJoin('users', 'users.id', 'tasks.assignee_id').where('tasks.topic_id', t.id);
  if (who) q = q.where('tasks.assignee_id', who);
  const tasks = await q.orderByRaw("case tasks.priority when 'high' then 0 when 'normal' then 1 else 2 end").orderBy('tasks.due_date').select('tasks.*', 'users.name as who_name', 'users.color as who_color');
  const people = await members(t.id, false);
  res.render('pages/board', { title: 'Board · ' + t.code, active: 'topics', tab: 'Board', crumb: crumb(t, 'Board'), tasks, people, who, showAllDone: req.query.done === 'all' });
});
r.post('/topics/:tid/tasks', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title);
  if (title.length < 2) { req.flash('error', 'Give the task a title.'); return res.redirect('/topics/' + t.id + '/board'); }
  let assignee = parseInt(req.body.assignee_id, 10) || null;
  if (assignee && !(await db('topic_members').where({ topic_id: t.id, user_id: assignee }).whereNot('role', 'guest').first())) assignee = null;
  if (req.topicRole !== 'leader' && assignee && assignee !== req.user.id) assignee = req.user.id; // members can only assign themselves
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
  await db('tasks').insert({ topic_id: t.id, title, description: clean(req.body.description, 2000), status, priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : 'normal', assignee_id: assignee, due_date: validDate(req.body.due_date), created_by: req.user.id, completed_at: status === 'done' ? now() : null, created_at: now(), updated_at: now() });
  if (assignee) await notify(assignee, { kind: 'task', title: 'New task: ' + title, body: t.code, link: '/topics/' + t.id + '/board' }, req.user.id);
  await audit(req.user.id, t.id, 'task.created', 'Added task “' + title + '”');
  req.flash('ok', 'Task added.');
  res.redirect('/topics/' + t.id + '/board');
});
async function canEditTask(req, task) { return req.topicRole === 'leader' || task.assignee_id === req.user.id || task.created_by === req.user.id || !task.assignee_id; }
r.post('/topics/:tid/tasks/:id/move', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const task = await db('tasks').where({ id: parseInt(req.params.id, 10), topic_id: t.id }).first();
  const json = (req.get('accept') || '').includes('application/json');
  if (!task) return json ? res.status(404).json({ error: 'Not found' }) : auth.notFound(res);
  if (!(await canEditTask(req, task))) return json ? res.status(403).json({ error: 'Only the assignee or a leader can move this task.' }) : auth.forbidden(res, 'Only the assignee or a leader can move this task.');
  const status = STATUSES.includes(req.body.status) ? req.body.status : task.status;
  const hasBrief = await db('task_criteria').where({ task_id: task.id }).first();
  if (hasBrief && req.topicRole !== 'leader' && status !== task.status && (['review', 'done'].includes(status) || ['review', 'done'].includes(task.status))) {
    const msg = 'This task has a brief — submit and review it on the task page.';
    if (json) return res.status(409).json({ error: msg });
    req.flash('error', msg); return res.redirect('/topics/' + t.id + '/tasks/' + task.id);
  }
  if (status !== task.status) {
    await db('tasks').where({ id: task.id }).update({ status, completed_at: status === 'done' ? now() : null, updated_at: now() });
    const labels = { todo: 'To do', doing: 'In progress', review: 'In review', done: 'Done' };
    await audit(req.user.id, t.id, 'task.moved', 'Moved “' + task.title + '” to ' + labels[status]);
    if (status === 'review' && task.created_by && task.created_by !== req.user.id) await notify(task.created_by, { kind: 'task', title: '“' + task.title + '” is ready for review', body: t.code, link: '/topics/' + t.id + '/board' }, req.user.id);
  }
  if (json) return res.json({ ok: true, status });
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/') && !req.body.back.startsWith('//') ? req.body.back : '/topics/' + t.id + '/board';
  res.redirect(back);
});
r.post('/topics/:tid/tasks/:id', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const task = await db('tasks').where({ id: parseInt(req.params.id, 10), topic_id: t.id }).first();
  if (!task) return auth.notFound(res);
  if (!(await canEditTask(req, task))) return auth.forbidden(res, 'Only the assignee or a leader can change this task.');
  if (req.body.action === 'delete') {
    await db('tasks').where({ id: task.id }).del();
    await audit(req.user.id, t.id, 'task.deleted', 'Deleted task “' + task.title + '”');
    req.flash('ok', 'Task deleted.');
    return res.redirect('/topics/' + t.id + '/board');
  }
  let assignee = req.body.assignee_id === '' ? null : parseInt(req.body.assignee_id, 10) || task.assignee_id;
  if (req.topicRole !== 'leader' && assignee !== task.assignee_id && assignee !== req.user.id) assignee = task.assignee_id;
  if (assignee && !(await db('topic_members').where({ topic_id: t.id, user_id: assignee }).whereNot('role', 'guest').first())) assignee = task.assignee_id;
  await db('tasks').where({ id: task.id }).update({ assignee_id: assignee, due_date: req.body.due_date !== undefined ? validDate(req.body.due_date) : task.due_date, updated_at: now() });
  if (assignee && assignee !== task.assignee_id) await notify(assignee, { kind: 'task', title: 'Assigned to you: ' + task.title, body: t.code, link: '/topics/' + t.id + '/board' }, req.user.id);
  req.flash('ok', 'Task updated.');
  res.redirect('/topics/' + t.id + '/board');
});

// ================= Meetings =================
r.get('/topics/:tid/meetings', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const list = await db('meetings').leftJoin('users', 'users.id', 'meetings.created_by').where('meetings.topic_id', t.id).orderBy('meetings.starts_at').select('meetings.*', 'users.name as by');
  const cut = Date.now() - 3600000;
  res.render('pages/meetings', { title: 'Meetings · ' + t.code, active: 'topics', tab: 'Meetings', crumb: crumb(t, 'Meetings'), upcoming: list.filter((m) => toDate(m.starts_at) >= cut), past: list.filter((m) => toDate(m.starts_at) < cut).reverse() });
});
r.post('/topics/:tid/meetings', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title, 200);
  const when = new Date(String(req.body.date || '') + 'T' + String(req.body.time || '09:00') + ':00' + (/^[+-]\d{2}:\d{2}$/.test(req.body.tz || '') ? req.body.tz : '+11:00'));
  const link = safeUrl(req.body.link);
  if (!title || isNaN(when)) { req.flash('error', 'Add a title, date and time.'); return res.redirect('/topics/' + t.id + '/meetings'); }
  if (req.body.link && !link) { req.flash('error', 'That meeting link doesn’t look valid. Paste the full https:// link.'); return res.redirect('/topics/' + t.id + '/meetings'); }
  await db('meetings').insert({ topic_id: t.id, title, starts_at: when.toISOString(), duration_min: Math.min(480, Math.max(10, parseInt(req.body.duration, 10) || 60)), link: link || null, platform: detectPlatform(link), agenda: clean(req.body.agenda, 2000), created_by: req.user.id, created_at: now() });
  const others = (await members(t.id, false)).map((m) => m.id);
  await notify(others, { kind: 'meeting', title: 'Meeting scheduled: ' + title, body: when.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' }) + (link ? ' · ' + detectPlatform(link) : ''), link: '/topics/' + t.id + '/meetings' }, req.user.id);
  await audit(req.user.id, t.id, 'meeting.created', 'Scheduled “' + title + '”');
  req.flash('ok', 'Meeting scheduled and members notified.');
  res.redirect('/topics/' + t.id + '/meetings');
});
r.post('/topics/:tid/meetings/:mid', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const m = await db('meetings').where({ id: parseInt(req.params.mid, 10), topic_id: t.id }).first();
  if (!m) return auth.notFound(res);
  if (req.body.action === 'delete') {
    if (req.topicRole !== 'leader' && m.created_by !== req.user.id) return auth.forbidden(res, 'Only the organiser or a leader can cancel this meeting.');
    await db('meetings').where({ id: m.id }).del();
    await audit(req.user.id, t.id, 'meeting.cancelled', 'Cancelled “' + m.title + '”');
    req.flash('ok', 'Meeting cancelled.');
  } else {
    await db('meetings').where({ id: m.id }).update({ minutes: clean(req.body.minutes, 10000) });
    await audit(req.user.id, t.id, 'meeting.minutes', 'Saved minutes for “' + m.title + '”');
    req.flash('ok', 'Minutes saved.');
  }
  res.redirect('/topics/' + t.id + '/meetings#m' + m.id);
});

module.exports = r;
