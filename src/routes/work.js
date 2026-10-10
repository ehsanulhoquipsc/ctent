'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit } = require('../lib/events');
const { now, matchScore, detectPlatform, safeUrl, toDate } = require('../lib/util');
const rooms = require('../lib/rooms');

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
  if (action === 'edit') {
    const title = clean(req.body.title);
    if (title.length < 3) { req.flash('error', 'Give the part a title.'); return res.redirect('/topics/' + t.id + '/plan'); }
    await db('parts').where({ id: part.id }).update({ title, description: clean(req.body.description, 1000), skills: clean(req.body.skills, 400), due_date: validDate(req.body.due_date) });
    await audit(req.user.id, t.id, 'part.edited', 'Edited part “' + title + '”');
    req.flash('ok', 'Part updated.');
    return res.redirect('/topics/' + t.id + '/plan');
  }
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
// A task someone else gave you is locked for you: you can work on it and send it for review,
// but you can't reassign it, delete it, or mark it done yourself — even if you're a co-leader.
const givenByOther = (req, task) => task.assignee_id === req.user.id && !!task.created_by && task.created_by !== req.user.id;
async function canEditTask(req, task) { return req.topicRole === 'leader' || task.assignee_id === req.user.id || task.created_by === req.user.id || !task.assignee_id; }
r.post('/topics/:tid/tasks/:id/move', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const task = await db('tasks').where({ id: parseInt(req.params.id, 10), topic_id: t.id }).first();
  const json = (req.get('accept') || '').includes('application/json');
  if (!task) return json ? res.status(404).json({ error: 'Not found' }) : auth.notFound(res);
  if (!(await canEditTask(req, task))) return json ? res.status(403).json({ error: 'Only the assignee or a leader can move this task.' }) : auth.forbidden(res, 'Only the assignee or a leader can move this task.');
  const status = STATUSES.includes(req.body.status) ? req.body.status : task.status;
  const hasBrief = await db('task_criteria').where({ task_id: task.id }).first();
  if (hasBrief && (req.topicRole !== 'leader' || givenByOther(req, task)) && status !== task.status && (['review', 'done'].includes(status) || ['review', 'done'].includes(task.status))) {
    const msg = 'This task has a brief — submit and review it on the task page.';
    if (json) return res.status(409).json({ error: msg });
    req.flash('error', msg); return res.redirect('/topics/' + t.id + '/tasks/' + task.id);
  }
  if (givenByOther(req, task) && status !== task.status && (status === 'done' || task.status === 'done')) {
    const msg = 'This task was assigned to you — move it to In review and the person who assigned it will mark it done.';
    if (json) return res.status(409).json({ error: msg });
    req.flash('error', msg); return res.redirect('/topics/' + t.id + '/board');
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
  if (givenByOther(req, task) && (req.body.action === 'delete' || (req.body.assignee_id !== undefined && String(req.body.assignee_id) !== String(task.assignee_id)))) {
    return auth.forbidden(res, 'This task was assigned to you by someone else. Ask them (or another leader) to reassign or delete it.');
  }
  if (req.body.action === 'delete') {
    if (req.topicRole !== 'leader' && task.created_by !== req.user.id) return auth.forbidden(res, 'Only a leader or the person who created this task can delete it.');
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

// ================= Meeting rooms =================
async function syncChat(room, ids, name) {
  if (!room.channel_id) return;
  const ch = await db('channels').where({ id: room.channel_id, kind: 'room' }).first();
  if (!ch) return;
  if (name) await db('channels').where({ id: ch.id }).update({ name });
  await db('channel_members').where({ channel_id: ch.id }).whereNotIn('user_id', ids.concat([0])).del();
  const have = (await db('channel_members').where({ channel_id: ch.id }).select('user_id')).map((x) => x.user_id);
  const add = ids.filter((id) => !have.includes(id));
  if (add.length) await db('channel_members').insert(add.map((user_id) => ({ channel_id: ch.id, user_id })));
}
const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
r.post('/topics/:tid/rooms', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const name = clean(req.body.name, 80);
  if (!name) { req.flash('error', 'Give the room a name.'); return res.redirect('/topics/' + t.id + '/meetings#rooms'); }
  const valid = (await members(t.id, false)).map((m) => m.id);
  const ids = [...new Set([req.user.id, ...[].concat(req.body.members || []).map((x) => parseInt(x, 10))])].filter((x) => valid.includes(x));
  const link = safeUrl(req.body.link) || rooms.autoLink(t.code, name);
  if (req.body.link && !safeUrl(req.body.link)) { req.flash('error', 'That meeting link doesn’t look valid. Paste the full https:// link, or leave it blank for a free video room.'); return res.redirect('/topics/' + t.id + '/meetings#rooms'); }
  const [kind, ref] = String(req.body.based_on || '').split(':');
  const part = kind === 'part' ? await db('parts').where({ id: parseInt(ref, 10), topic_id: t.id }).first() : null;
  const task = kind === 'task' ? await db('tasks').where({ id: parseInt(ref, 10), topic_id: t.id }).first() : null;
  let channelId = null;
  if (req.body.chat === '1') {
    channelId = await db.insertId('channels', { topic_id: null, name: slug(t.code + '-' + name) || 'team-room', kind: 'room', purpose: 'Chat for the ' + name + ' room in ' + t.code, created_by: req.user.id, created_at: now() });
    await db('channel_members').insert(ids.map((user_id) => ({ channel_id: channelId, user_id })));
  }
  const id = await db.insertId('meeting_rooms', { topic_id: t.id, name, kind: 'team', purpose: clean(req.body.purpose, 240) || null, link, platform: detectPlatform(link), part_id: part ? part.id : null, task_id: task ? task.id : null, channel_id: channelId, created_by: req.user.id, created_at: now() });
  await db('meeting_room_members').insert(ids.map((user_id) => ({ room_id: id, user_id })));
  await notify(ids, { kind: 'meeting', title: req.user.name + ' added you to the room “' + name + '”', body: t.code + ' · join any time from Meetings', link: '/topics/' + t.id + '/meetings#room' + id }, req.user.id);
  await audit(req.user.id, t.id, 'room.created', 'Created the room “' + name + '” for ' + ids.length + ' people');
  req.flash('ok', 'Room created' + (channelId ? ' with its own chat' : '') + '.');
  res.redirect('/topics/' + t.id + '/meetings#room' + id);
});
r.post('/topics/:tid/rooms/:rid', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const room = await db('meeting_rooms').where({ id: parseInt(req.params.rid, 10), topic_id: t.id }).first();
  if (!room) return auth.notFound(res);
  const leader = req.topicRole === 'leader';
  if (!(leader || (room.kind === 'team' && room.created_by === req.user.id))) return auth.forbidden(res, room.kind === 'project' ? 'Only a topic leader can change the project room.' : 'Only the person who made this room or a leader can change it.');
  const back = '/topics/' + t.id + '/meetings#rooms';
  if (req.body.action === 'delete') {
    if (room.kind === 'project') { req.flash('error', 'The project room can’t be deleted — it belongs to the whole topic.'); return res.redirect(back); }
    await db('meeting_rooms').where({ id: room.id }).del();
    await audit(req.user.id, t.id, 'room.deleted', 'Deleted the room “' + room.name + '”');
    req.flash('ok', 'Room deleted.' + (room.channel_id ? ' Its chat history stays in Messages.' : ''));
    return res.redirect(back);
  }
  if (req.body.action === 'newlink') {
    const link = rooms.autoLink(t.code, room.name);
    await db('meeting_rooms').where({ id: room.id }).update({ link, platform: detectPlatform(link) });
    req.flash('ok', 'New free video link created.');
    return res.redirect(back);
  }
  const name = clean(req.body.name, 80) || room.name;
  const link = req.body.link ? safeUrl(req.body.link) : room.link;
  if (!link) { req.flash('error', 'That meeting link doesn’t look valid. Paste the full https:// link.'); return res.redirect(back); }
  await db('meeting_rooms').where({ id: room.id }).update({ name, purpose: clean(req.body.purpose, 240) || null, link, platform: detectPlatform(link) });
  if (room.kind === 'team' && req.body.members !== undefined) {
    const valid = (await members(t.id, false)).map((m) => m.id);
    const ids = [...new Set([].concat(req.body.members || []).map((x) => parseInt(x, 10)))].filter((x) => valid.includes(x));
    if (!ids.length) { req.flash('error', 'A room needs at least one person.'); return res.redirect(back); }
    const before = (await db('meeting_room_members').where({ room_id: room.id }).select('user_id')).map((x) => x.user_id);
    await db('meeting_room_members').where({ room_id: room.id }).del();
    await db('meeting_room_members').insert(ids.map((user_id) => ({ room_id: room.id, user_id })));
    await syncChat(room, ids, slug(t.code + '-' + name));
    const added = ids.filter((x) => !before.includes(x));
    if (added.length) await notify(added, { kind: 'meeting', title: req.user.name + ' added you to the room “' + name + '”', body: t.code, link: '/topics/' + t.id + '/meetings#room' + room.id }, req.user.id);
  }
  await audit(req.user.id, t.id, 'room.edited', 'Edited the room “' + name + '”');
  req.flash('ok', 'Room saved.');
  res.redirect(back);
});

// ================= Meetings =================
r.get('/topics/:tid/meetings', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const list = await db('meetings').leftJoin('users', 'users.id', 'meetings.created_by').where('meetings.topic_id', t.id).orderBy('meetings.starts_at').select('meetings.*', 'users.name as by');
  const cut = Date.now() - 3600000;
  const roomList = await rooms.roomsFor(t, req.user, req.topicRole);
  const people = await members(t.id, false);
  // "Based on" options: each part's team and each task's people, so a room can be set up in one click.
  const parts = await db('parts').where({ topic_id: t.id }).orderBy('id').select('id', 'title', 'proposed_user_id', 'status');
  const tasks = await db('tasks').where({ topic_id: t.id }).whereNot('status', 'done').orderBy('id', 'desc').limit(40).select('id', 'title', 'part_id', 'assignee_id', 'created_by', 'reviewer_id');
  const valid = new Set(people.map((p) => p.id));
  const presets = [
    ...parts.map((p) => ({ key: 'part:' + p.id, label: 'Part · ' + p.title, name: p.title, ids: [...new Set([p.status === 'approved' ? p.proposed_user_id : null, ...tasks.filter((x) => x.part_id === p.id).map((x) => x.assignee_id)])].filter((x) => valid.has(x)) })),
    ...tasks.map((x) => ({ key: 'task:' + x.id, label: 'Task · ' + x.title, name: x.title, ids: [...new Set([x.assignee_id, x.reviewer_id || x.created_by])].filter((y) => valid.has(y)) }))
  ].map((o) => ({ ...o, name: o.name.slice(0, 80) }));
  const roomOf = Object.fromEntries(roomList.map((r) => [r.id, r]));
  res.render('pages/meetings', { title: 'Meetings · ' + t.code, active: 'topics', tab: 'Meetings', crumb: crumb(t, 'Meetings'), upcoming: list.filter((m) => toDate(m.starts_at) >= cut), past: list.filter((m) => toDate(m.starts_at) < cut).reverse(),
    rooms: roomList, roomOf, people, presets, roomSel: parseInt(req.query.room, 10) || null });
});
r.post('/topics/:tid/meetings', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title, 200);
  const when = new Date(String(req.body.date || '') + 'T' + String(req.body.time || '09:00') + ':00' + (/^[+-]\d{2}:\d{2}$/.test(req.body.tz || '') ? req.body.tz : '+11:00'));
  let link = safeUrl(req.body.link);
  if (!title || isNaN(when)) { req.flash('error', 'Add a title, date and time.'); return res.redirect('/topics/' + t.id + '/meetings'); }
  if (req.body.link && !link) { req.flash('error', 'That meeting link doesn’t look valid. Paste the full https:// link.'); return res.redirect('/topics/' + t.id + '/meetings'); }
  const visible = await rooms.roomsFor(t, req.user, req.topicRole);
  const room = visible.find((r) => r.id === parseInt(req.body.room_id, 10)) || null;
  if (room && !link) link = room.link;
  await db('meetings').insert({ topic_id: t.id, title, starts_at: when.toISOString(), duration_min: Math.min(480, Math.max(10, parseInt(req.body.duration, 10) || 60)), link: link || null, platform: detectPlatform(link), agenda: clean(req.body.agenda, 2000), room_id: room ? room.id : null, created_by: req.user.id, created_at: now() });
  // A team-room meeting invites that team; otherwise everyone in the topic.
  const others = room && room.kind === 'team' ? room.people.map((p) => p.id) : (await members(t.id, false)).map((m) => m.id);
  await notify(others, { kind: 'meeting', title: 'Meeting scheduled: ' + title, body: when.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' }) + (link ? ' · ' + detectPlatform(link) : ''), link: '/topics/' + t.id + '/meetings' }, req.user.id);
  await audit(req.user.id, t.id, 'meeting.created', 'Scheduled “' + title + '”');
  req.flash('ok', 'Meeting scheduled and members notified.');
  res.redirect('/topics/' + t.id + '/meetings');
});
r.post('/topics/:tid/meetings/:mid', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const m = await db('meetings').where({ id: parseInt(req.params.mid, 10), topic_id: t.id }).first();
  if (!m) return auth.notFound(res);
  const canManage = req.topicRole === 'leader' || m.created_by === req.user.id;
  if (req.body.action === 'edit') {
    if (!canManage) return auth.forbidden(res, 'Only the organiser or a leader can edit this meeting.');
    const title = clean(req.body.title, 200);
    const when = new Date(String(req.body.date || '') + 'T' + String(req.body.time || '09:00') + ':00' + (/^[+-]\d{2}:\d{2}$/.test(req.body.tz || '') ? req.body.tz : '+11:00'));
    const link = safeUrl(req.body.link);
    if (!title || isNaN(when)) { req.flash('error', 'Add a title, date and time.'); return res.redirect('/topics/' + t.id + '/meetings#m' + m.id); }
    if (req.body.link && !link) { req.flash('error', 'That meeting link doesn’t look valid. Paste the full https:// link.'); return res.redirect('/topics/' + t.id + '/meetings#m' + m.id); }
    await db('meetings').where({ id: m.id }).update({ title, starts_at: when.toISOString(), duration_min: Math.min(480, Math.max(10, parseInt(req.body.duration, 10) || 60)), link: link || null, platform: detectPlatform(link), agenda: clean(req.body.agenda, 2000) });
    if (when.toISOString() !== new Date(m.starts_at).toISOString() || title !== m.title) {
      const others = (await members(t.id, false)).map((x) => x.id);
      await notify(others, { kind: 'meeting', title: 'Meeting updated: ' + title, body: when.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' }), link: '/topics/' + t.id + '/meetings' }, req.user.id);
    }
    await audit(req.user.id, t.id, 'meeting.edited', 'Edited “' + title + '”');
    req.flash('ok', 'Meeting updated.');
    return res.redirect('/topics/' + t.id + '/meetings#m' + m.id);
  }
  if (req.body.action === 'delete') {
    if (!canManage) return auth.forbidden(res, 'Only the organiser or a leader can cancel this meeting.');
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
