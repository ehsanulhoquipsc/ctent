'use strict';
// Task workspace: leader writes a brief → member works through it → leader reviews against "done when".
const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit, topicLeaders } = require('../lib/events');
const { now, matchScore, todayStr } = require('../lib/util');

const r = express.Router();
const MAX = parseInt(process.env.MAX_UPLOAD_MB || '10', 10) * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });
const BLOCKED_EXT = /\.(exe|bat|cmd|com|msi|scr|ps1|vbs|js|jar|sh|dll)$/i;
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const validDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
const list = (v) => [].concat(v || []).map((x) => String(x).trim()).filter(Boolean);
const STAGE = { todo: 'assigned', doing: 'working', changes: 'changes', review: 'submitted', done: 'approved' };
const DELIVERABLES = { doc: ['📄', 'Document'], data: ['📊', 'Dataset'], analysis: ['🔬', 'Analysis'], slides: ['🖥', 'Slides'], other: ['✳', 'Other'] };
const crumb = (t, label) => '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / <a href="/topics/' + t.id + '/board">Board</a> / ' + label;

function writable(req, res, next) {
  if (req.topic.status === 'archived') { req.flash('error', 'This topic is archived and read-only.'); return res.redirect('/topics/' + req.topic.id); }
  next();
}
async function people(topicId) {
  return db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', topicId).whereNot('topic_members.role', 'guest')
    .orderBy('users.name').select('users.id', 'users.name', 'users.color', 'users.title', 'topic_members.role');
}
async function loadTask(req, res, next) {
  const task = await db('tasks').where({ id: parseInt(req.params.id, 10), topic_id: req.topic.id }).first();
  if (!task) return auth.notFound(res, 'That task doesn’t exist or was deleted.');
  req.task = task;
  req.isAssignee = task.assignee_id === req.user.id;
  req.isReviewer = req.topicRole === 'leader' || task.reviewer_id === req.user.id;
  next();
}
const back = (req) => '/topics/' + req.topic.id + '/tasks/' + req.task.id;
async function log(taskId, userId, kind, text) { await db('task_updates').insert({ task_id: taskId, user_id: userId, kind, text: text || null, created_at: now() }); }
async function reviewers(task) {
  if (task.reviewer_id) return [task.reviewer_id];
  return topicLeaders(task.topic_id);
}
function mustBeAssignee(req, res, next) {
  if (!req.isAssignee) return auth.forbidden(res, 'Only the person this task is assigned to can do this.');
  next();
}

// ================= Create (leader) =================
r.get('/topics/:tid/tasks/new', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const ppl = await people(t.id);
  const parts = await db('parts').where({ topic_id: t.id }).orderBy('id');
  const partId = parseInt(req.query.part, 10) || null;
  const part = parts.find((p) => p.id === partId) || null;
  const exp = ppl.length ? await db('expertise').whereIn('user_id', ppl.map((p) => p.id)) : [];
  const load = Object.fromEntries((await db('tasks').whereIn('assignee_id', ppl.map((p) => p.id).concat([0])).whereNot('status', 'done').groupBy('assignee_id').select('assignee_id').count({ n: '*' })).map((x) => [x.assignee_id, Number(x.n)]));
  const ranked = ppl.map((p) => ({ ...p, score: part ? matchScore(part.skills, exp.filter((e) => e.user_id === p.id)) : 0, load: load[p.id] || 0 }))
    .sort((a, b) => b.score - a.score || a.load - b.load);
  const files = await db('files').where({ topic_id: t.id }).orderBy('id', 'desc').limit(30).select('id', 'name', 'folder');
  res.render('pages/task-new', { title: 'New task · ' + t.code, active: 'topics', tab: 'Board', crumb: crumb(t, 'New task'), people: ranked, parts, part, files, deliverables: DELIVERABLES,
    dues: [['1w', 'In 1 week', todayStr(7)], ['2w', 'In 2 weeks', todayStr(14)], ['1m', 'In a month', todayStr(30)]] });
});
r.post('/topics/:tid/tasks/new', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title);
  const criteria = list(req.body.criteria).map((x) => x.slice(0, 300)).slice(0, 12);
  const assignee = parseInt(req.body.assignee_id, 10) || null;
  if (title.length < 3 || !criteria.length) { req.flash('error', 'Add a title and at least one “done when” point.'); return res.redirect('/topics/' + t.id + '/tasks/new'); }
  if (assignee && !(await db('topic_members').where({ topic_id: t.id, user_id: assignee }).whereNot('role', 'guest').first())) { req.flash('error', 'Choose someone who is a member of this topic.'); return res.redirect('/topics/' + t.id + '/tasks/new'); }
  const partId = parseInt(req.body.part_id, 10) || null;
  const part = partId ? await db('parts').where({ id: partId, topic_id: t.id }).first() : null;
  const id = await db.insertId('tasks', {
    topic_id: t.id, part_id: part ? part.id : null, title, goal: clean(req.body.goal, 2000) || null, deliverable: DELIVERABLES[req.body.deliverable] ? req.body.deliverable : 'doc',
    status: 'todo', priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : 'normal', assignee_id: assignee, reviewer_id: req.user.id,
    due_date: validDate(req.body.due_date), created_by: req.user.id, created_at: now(), updated_at: now()
  });
  await db('task_criteria').insert(criteria.map((text, position) => ({ task_id: id, text, position })));
  const steps = list(String(req.body.steps || '').split(/\r?\n/)).map((x) => x.slice(0, 300)).slice(0, 20);
  if (steps.length) await db('task_steps').insert(steps.map((text, position) => ({ task_id: id, text, position })));
  const fileIds = list(req.body.resources).map((x) => parseInt(x, 10)).filter(Boolean);
  const okFiles = fileIds.length ? await db('files').where({ topic_id: t.id }).whereIn('id', fileIds).select('id', 'name') : [];
  if (okFiles.length) await db('task_resources').insert(okFiles.map((f) => ({ task_id: id, file_id: f.id, title: f.name })));
  await log(id, req.user.id, 'assigned', 'Task created' + (assignee ? '' : ' (no one assigned yet)') + '.');
  if (assignee) await notify(assignee, { kind: 'task', title: req.user.name + ' gave you a task: ' + title, body: t.code + ' · open the brief to get started', link: '/topics/' + t.id + '/tasks/' + id }, req.user.id);
  await audit(req.user.id, t.id, 'task.created', 'Created task “' + title + '” with a brief');
  req.flash('ok', assignee ? 'Task sent. They’ve been notified.' : 'Task created. Assign someone from the task page or the board.');
  res.redirect('/topics/' + t.id + '/tasks/' + id);
});

// ================= Workspace =================
r.get('/topics/:tid/tasks/:id', auth.loadTopic('member'), loadTask, async (req, res) => {
  const t = req.topic, task = req.task;
  const [criteria, steps, resources, versions, updates, comments] = await Promise.all([
    db('task_criteria').where({ task_id: task.id }).orderBy('position'),
    db('task_steps').where({ task_id: task.id }).orderBy('position').orderBy('id'),
    db('task_resources').leftJoin('files', 'files.id', 'task_resources.file_id').where('task_resources.task_id', task.id).select('task_resources.*', 'files.name as file_name', 'files.folder'),
    db('task_versions').leftJoin('files', 'files.id', 'task_versions.file_id').where('task_versions.task_id', task.id).orderBy('task_versions.version', 'desc').select('task_versions.*', 'files.name as file_name', 'files.size as file_size'),
    db('task_updates').leftJoin('users', 'users.id', 'task_updates.user_id').where('task_updates.task_id', task.id).orderBy('task_updates.id', 'desc').select('task_updates.*', 'users.name', 'users.color', 'users.id as uid'),
    db('task_comments').leftJoin('users', 'users.id', 'task_comments.user_id').where('task_comments.task_id', task.id).orderBy('task_comments.id').select('task_comments.*', 'users.name', 'users.color', 'users.id as uid')
  ]);
  const ids = [task.assignee_id, task.created_by, task.reviewer_id].filter(Boolean);
  const users = ids.length ? await db('users').whereIn('id', ids).select('id', 'name', 'color', 'title') : [];
  const by = (id) => users.find((x) => x.id === id) || null;
  const part = task.part_id ? await db('parts').where({ id: task.part_id }).first() : null;
  const ppl = await people(t.id);
  const stage = STAGE[task.status] || 'working';
  const hasBrief = criteria.length > 0;
  const done = steps.filter((s) => s.done).length;
  const latest = versions[0] || null;
  const isM = req.isAssignee;
  const isR = req.isReviewer && !isM;
  const assignee = by(task.assignee_id), reviewer = by(task.reviewer_id) || by(task.created_by);
  const first = (u) => (u ? u.name.replace(/^Dr\.\s*/, '').split(' ')[0] : 'someone');

  // The single "next step" for whoever is looking.
  let next;
  if (isM) {
    if (stage === 'assigned') next = { tone: 'indigo', icon: '👋', kicker: 'Your next step', title: 'Read the brief, then press Start', text: first(reviewer) + ' will see that you’ve started. Add your own steps to plan the work.', primary: { label: 'Start working', action: 'start' } };
    else if (stage === 'working' || stage === 'changes') {
      const fresh = latest && (latest.state === 'draft');
      next = stage === 'changes'
        ? { tone: 'red', icon: '↺', kicker: 'Round ' + task.round + ' · changes requested', title: first(reviewer) + ' asked for changes', text: fresh ? 'v' + latest.version + ' is uploaded. Send it back when you’ve made the changes.' : 'Upload a revised version, then send it back. Earlier versions stay in the history.', ...(fresh ? { primary: { label: 'Send v' + latest.version + ' for review', action: 'submit' } } : { link: { label: 'Upload v' + ((latest ? latest.version : 0) + 1), href: '?tab=files' } }) }
        : { tone: 'burgundy', icon: '✍', kicker: 'Your next step', title: steps.length && done < steps.length ? done + ' of ' + steps.length + ' steps done — keep going' : (latest ? 'Ready? Send it for review' : 'Upload your draft when it’s ready'), text: latest ? 'Your draft v' + latest.version + ' is uploaded. When it meets every “done when” point, send it to ' + first(reviewer) + '.' : 'Upload your work in Work & files. When it meets every “done when” point, send it to ' + first(reviewer) + '.', ...(latest ? { primary: { label: 'Submit for review', action: 'submit' } } : { link: { label: 'Upload draft', href: '?tab=files' } }) };
    } else if (stage === 'submitted') next = { tone: 'amber', icon: '⏳', kicker: 'With ' + first(reviewer), title: 'Waiting for review', text: 'You’ll get a notification when ' + first(reviewer) + ' has reviewed it. You can withdraw it if you need to make edits.', secondary: { label: 'Withdraw to edit', action: 'withdraw' } };
    else next = { tone: 'green', icon: '🎉', kicker: 'Done', title: 'Approved and locked', text: 'Nothing else to do here. Nice work.', link: { label: 'Go to my tasks', href: '/tasks' } };
  } else if (isR) {
    if (!task.assignee_id) next = { tone: 'grey', icon: '👤', kicker: 'Needs an owner', title: 'Nobody is assigned yet', text: 'Pick someone from the board’s assignee menu.', link: { label: 'Open board', href: '/topics/' + t.id + '/board' } };
    else if (stage === 'assigned') next = { tone: 'grey', icon: '⏱', kicker: 'Waiting on ' + first(assignee), title: first(assignee) + ' hasn’t started yet', text: 'Send a friendly nudge if it’s been a few days.', secondary: { label: 'Send a nudge', action: 'nudge' } };
    else if (stage === 'working') next = { tone: task.blocked ? 'red' : 'indigo', icon: task.blocked ? '⚑' : '📈', kicker: task.blocked ? 'Blocked' : 'In progress', title: task.blocked ? first(assignee) + ' is blocked and needs help' : first(assignee) + ' is working on it' + (steps.length ? ' — ' + done + ' of ' + steps.length + ' steps' : ''), text: task.blocked ? 'See the latest update below and reply in the task chat.' : 'Nothing for you to do yet. You’ll be notified when it’s submitted.', secondary: { label: 'Send a nudge', action: 'nudge' } };
    else if (stage === 'submitted') next = { tone: 'teal', icon: '👀', kicker: 'Your next step', title: 'v' + (latest ? latest.version : 1) + ' is ready for your review', text: hasBrief ? 'Tick each “done when” point it meets, then approve or request changes in the review box.' : 'Approve it or request changes in the review box.', link: { label: 'Review now', href: '#review' } };
    else if (stage === 'changes') next = { tone: 'red', icon: '↺', kicker: 'Waiting on ' + first(assignee), title: 'You requested changes', text: 'You’ll be notified when the next version arrives.' };
    else next = { tone: 'green', icon: '✓', kicker: 'Done', title: 'Approved and locked', text: 'This task is complete.' };
  } else {
    next = { tone: 'grey', icon: '👁', kicker: 'View only', title: 'This task belongs to ' + first(assignee), text: 'You can follow progress and join the conversation.' };
  }
  const order = { assigned: 0, working: 1, changes: 1, submitted: 2, approved: 3 }[stage];
  res.render('pages/task', {
    title: task.title, active: 'topics', tab: 'Board', crumb: crumb(t, 'T-' + task.id),
    task, stage, order, criteria, steps, done, resources, versions, latest, updates, comments, assignee, reviewer, part, people: ppl, next, hasBrief,
    canManage: canManage(req), canDelete: req.topicRole === 'leader' || task.created_by === req.user.id, isLeader: req.topicRole === 'leader', DELIVERABLES,
    isM, isR, canEditSteps: isM && (stage === 'working' || stage === 'changes' || stage === 'assigned'), canUpload: isM && (stage === 'working' || stage === 'changes'),
    deliverable: DELIVERABLES[task.deliverable] || null, maxMb: MAX / 1024 / 1024, tabSel: ['steps', 'files', 'updates'].includes(req.query.tab) ? req.query.tab : (stage === 'submitted' && isR ? 'files' : 'steps')
  });
});

// ---------- Member actions ----------
r.post('/topics/:tid/tasks/:id/act', auth.loadTopic('member'), writable, loadTask, async (req, res) => {
  const t = req.topic, task = req.task, action = req.body.action;
  const leaders = await reviewers(task);
  if (action === 'nudge') {
    if (!req.isReviewer || !task.assignee_id) return auth.forbidden(res, 'Only the reviewer can send a nudge.');
    await notify(task.assignee_id, { kind: 'task', title: req.user.name + ' sent a reminder: ' + task.title, link: back(req) }, req.user.id);
    await log(task.id, req.user.id, 'nudge', 'Sent a friendly reminder.');
    req.flash('ok', 'Reminder sent.');
    return res.redirect(back(req));
  }
  if (!req.isAssignee) return auth.forbidden(res, 'Only the person this task is assigned to can do this.');
  if (action === 'start' && task.status === 'todo') {
    await db('tasks').where({ id: task.id }).update({ status: 'doing', started_at: now(), updated_at: now() });
    await log(task.id, req.user.id, 'started', 'Started work.');
    await notify(leaders, { kind: 'task', title: req.user.name + ' started “' + task.title + '”', link: back(req) }, req.user.id);
    req.flash('ok', 'Started. Your reviewer can see it.');
  } else if (action === 'submit' && ['doing', 'changes'].includes(task.status)) {
    const latest = await db('task_versions').where({ task_id: task.id }).orderBy('version', 'desc').first();
    if (!latest || latest.state !== 'draft') { req.flash('error', 'Upload your work first, then submit it.'); return res.redirect(back(req) + '?tab=files'); }
    await db('task_versions').where({ id: latest.id }).update({ state: 'in_review' });
    await db('task_criteria').where({ task_id: task.id }).update({ met: false });
    await db('tasks').where({ id: task.id }).update({ status: 'review', blocked: false, submitted_at: now(), updated_at: now() });
    await log(task.id, req.user.id, 'submitted', 'Submitted v' + latest.version + ' for review.');
    await notify(leaders, { kind: 'review', title: req.user.name + ' submitted “' + task.title + '” (v' + latest.version + ')', body: t.code + ' · ready for your review', link: back(req) + '#review' }, req.user.id);
    await audit(req.user.id, t.id, 'task.submitted', 'Submitted v' + latest.version + ' of “' + task.title + '”');
    req.flash('ok', 'Sent for review.');
  } else if (action === 'withdraw' && task.status === 'review') {
    await db('task_versions').where({ task_id: task.id, state: 'in_review' }).update({ state: 'draft' });
    await db('tasks').where({ id: task.id }).update({ status: task.round > 1 ? 'changes' : 'doing', updated_at: now() });
    await log(task.id, req.user.id, 'withdrawn', 'Withdrew the submission to make edits.');
    req.flash('ok', 'Withdrawn. You can edit and submit again.');
  }
  res.redirect(back(req));
});

r.post('/topics/:tid/tasks/:id/steps', auth.loadTopic('member'), writable, loadTask, mustBeAssignee, async (req, res) => {
  const text = clean(req.body.text, 300);
  if (text) {
    const max = await db('task_steps').where({ task_id: req.task.id }).max({ p: 'position' }).first();
    await db('task_steps').insert({ task_id: req.task.id, text, position: (Number(max.p) || 0) + 1 });
  }
  res.redirect(back(req) + '?tab=steps');
});
r.post('/topics/:tid/tasks/:id/steps/:sid', auth.loadTopic('member'), writable, loadTask, mustBeAssignee, async (req, res) => {
  const step = await db('task_steps').where({ id: parseInt(req.params.sid, 10), task_id: req.task.id }).first();
  if (step) {
    if (req.body.action === 'remove') await db('task_steps').where({ id: step.id }).del();
    else if (req.body.action === 'rename') { const text = clean(req.body.text, 300); if (text) await db('task_steps').where({ id: step.id }).update({ text }); }
    else await db('task_steps').where({ id: step.id }).update({ done: !step.done });
  }
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
  res.redirect(back(req) + '?tab=steps');
});
r.post('/topics/:tid/tasks/:id/versions', auth.loadTopic('member'), writable, loadTask, upload.single('file'), auth.csrfAfterUpload, mustBeAssignee, async (req, res) => {
  const task = req.task;
  if (!['doing', 'changes'].includes(task.status)) { req.flash('error', task.status === 'todo' ? 'Press Start working first.' : 'You can’t upload while it’s in review or approved.'); return res.redirect(back(req) + '?tab=files'); }
  const f = req.file;
  if (!f || !f.size) { req.flash('error', 'Choose a file to upload.'); return res.redirect(back(req) + '?tab=files'); }
  const name = f.originalname.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 200);
  if (BLOCKED_EXT.test(name)) { req.flash('error', 'That file type isn’t allowed.'); return res.redirect(back(req) + '?tab=files'); }
  const fid = await db.insertId('files', { topic_id: req.topic.id, name, folder: 'Task drafts', mime: f.mimetype || 'application/octet-stream', size: f.size, data: f.buffer, uploaded_by: req.user.id, created_at: now() });
  const last = await db('task_versions').where({ task_id: task.id }).max({ v: 'version' }).first();
  const v = (Number(last.v) || 0) + 1;
  await db('task_versions').where({ task_id: task.id, state: 'draft' }).update({ state: 'superseded' });
  await db('task_versions').insert({ task_id: task.id, version: v, file_id: fid, state: 'draft', created_by: req.user.id, created_at: now() });
  await log(task.id, req.user.id, 'update', 'Uploaded draft v' + v + ' (' + name + ').');
  req.flash('ok', 'Uploaded as v' + v + '. Submit it when it’s ready.');
  res.redirect(back(req) + '?tab=files');
});
r.post('/topics/:tid/tasks/:id/updates', auth.loadTopic('member'), writable, loadTask, mustBeAssignee, async (req, res) => {
  const task = req.task;
  const text = clean(req.body.text, 2000);
  const blocked = req.body.blocked === '1';
  if (!text && !blocked) { req.flash('error', 'Write a short update first.'); return res.redirect(back(req) + '?tab=updates'); }
  await log(task.id, req.user.id, blocked ? 'blocked' : 'update', text || 'I’m blocked and need help.');
  await db('tasks').where({ id: task.id }).update({ blocked, updated_at: now() });
  const leaders = await reviewers(task);
  await notify(leaders, { kind: blocked ? 'request' : 'task', title: blocked ? req.user.name + ' is blocked on “' + task.title + '”' : req.user.name + ' posted an update on “' + task.title + '”', body: text.slice(0, 140), link: back(req) + '?tab=updates' }, req.user.id);
  req.flash('ok', blocked ? 'Your reviewer has been alerted.' : 'Update posted.');
  res.redirect(back(req) + '?tab=updates');
});

// ---------- Edit / delete the task itself (leader, creator or reviewer) ----------
const canManage = (req) => req.topicRole === 'leader' || req.task.created_by === req.user.id || req.task.reviewer_id === req.user.id;
r.post('/topics/:tid/tasks/:id/edit', auth.loadTopic('member'), writable, loadTask, async (req, res) => {
  const t = req.topic, task = req.task;
  if (!canManage(req)) return auth.forbidden(res, 'Only a leader or the person who set this task can edit it.');
  const title = clean(req.body.title);
  if (title.length < 3) { req.flash('error', 'Give the task a title (at least 3 characters).'); return res.redirect(back(req)); }
  let assignee = req.body.assignee_id === '' ? null : parseInt(req.body.assignee_id, 10) || task.assignee_id;
  if (assignee && !(await db('topic_members').where({ topic_id: t.id, user_id: assignee }).whereNot('role', 'guest').first())) assignee = task.assignee_id;
  await db('tasks').where({ id: task.id }).update({
    title, goal: clean(req.body.goal, 2000) || null, deliverable: DELIVERABLES[req.body.deliverable] ? req.body.deliverable : task.deliverable,
    priority: ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : task.priority,
    due_date: validDate(req.body.due_date), assignee_id: assignee, updated_at: now()
  });
  if (req.body.criteria !== undefined) {
    const wanted = list(String(req.body.criteria).split(/\r?\n/)).map((x) => x.slice(0, 300)).slice(0, 12);
    const old = await db('task_criteria').where({ task_id: task.id }).orderBy('position');
    const same = wanted.length === old.length && wanted.every((x, i) => x === old[i].text);
    if (!same) {
      await db('task_criteria').where({ task_id: task.id }).del();
      if (wanted.length) await db('task_criteria').insert(wanted.map((text, position) => ({ task_id: task.id, text, position, met: !!(old.find((o) => o.text === text) || {}).met })));
    }
  }
  await log(task.id, req.user.id, 'update', 'Edited the brief.');
  if (assignee && assignee !== task.assignee_id) await notify(assignee, { kind: 'task', title: req.user.name + ' gave you a task: ' + title, body: t.code, link: back(req) }, req.user.id);
  else if (task.assignee_id && task.assignee_id !== req.user.id) await notify(task.assignee_id, { kind: 'task', title: req.user.name + ' edited the brief for “' + title + '”', body: t.code, link: back(req) }, req.user.id);
  await audit(req.user.id, t.id, 'task.edited', 'Edited task “' + title + '”');
  req.flash('ok', 'Task updated.');
  res.redirect(back(req));
});
r.post('/topics/:tid/tasks/:id/delete', auth.loadTopic('member'), writable, loadTask, async (req, res) => {
  const t = req.topic, task = req.task;
  if (req.topicRole !== 'leader' && task.created_by !== req.user.id) return auth.forbidden(res, 'Only a leader or the person who created this task can delete it.');
  await db('tasks').where({ id: task.id }).del();
  await audit(req.user.id, t.id, 'task.deleted', 'Deleted task “' + task.title + '”');
  req.flash('ok', 'Task deleted.');
  res.redirect('/topics/' + t.id + '/board');
});

// ---------- Delete a draft version (assignee, before it's reviewed) ----------
r.post('/topics/:tid/tasks/:id/versions/:vid/delete', auth.loadTopic('member'), writable, loadTask, mustBeAssignee, async (req, res) => {
  const v = await db('task_versions').where({ id: parseInt(req.params.vid, 10), task_id: req.task.id }).first();
  if (!v) return auth.notFound(res);
  if (v.state !== 'draft') { req.flash('error', 'Only an unsent draft can be deleted. Versions that were reviewed stay in the history.'); return res.redirect(back(req) + '?tab=files'); }
  await db('task_versions').where({ id: v.id }).del();
  if (v.file_id) await db('files').where({ id: v.file_id }).del();
  await log(req.task.id, req.user.id, 'update', 'Deleted draft v' + v.version + '.');
  req.flash('ok', 'Draft v' + v.version + ' deleted.');
  res.redirect(back(req) + '?tab=files');
});

// ---------- Edit / delete own updates (system entries can't be edited) ----------
r.post('/topics/:tid/tasks/:id/updates/:uid', auth.loadTopic('member'), writable, loadTask, async (req, res) => {
  const e = await db('task_updates').where({ id: parseInt(req.params.uid, 10), task_id: req.task.id }).first();
  if (!e) return auth.notFound(res);
  const mine = e.user_id === req.user.id;
  if (!['update', 'blocked'].includes(e.kind)) return auth.forbidden(res, 'Automatic history entries can’t be changed.');
  if (req.body.action === 'delete') {
    if (!mine && req.topicRole !== 'leader') return auth.forbidden(res, 'You can only delete your own updates.');
    await db('task_updates').where({ id: e.id }).del();
    req.flash('ok', 'Update deleted.');
  } else {
    if (!mine) return auth.forbidden(res, 'You can only edit your own updates.');
    const text = clean(req.body.text, 2000);
    if (text) await db('task_updates').where({ id: e.id }).update({ text, edited_at: now() });
    req.flash('ok', 'Update edited.');
  }
  res.redirect(back(req) + '?tab=updates');
});

// ---------- Edit / delete chat comments ----------
r.post('/topics/:tid/tasks/:id/comments/:cid', auth.loadTopic('member'), loadTask, async (req, res) => {
  const c = await db('task_comments').where({ id: parseInt(req.params.cid, 10), task_id: req.task.id }).first();
  if (!c) return auth.notFound(res);
  const mine = c.user_id === req.user.id;
  if (req.body.action === 'delete') {
    if (!mine && req.topicRole !== 'leader') return auth.forbidden(res, 'You can only delete your own messages.');
    await db('task_comments').where({ id: c.id }).del();
  } else {
    if (!mine) return auth.forbidden(res, 'You can only edit your own messages.');
    const body = clean(req.body.body, 2000);
    if (body) await db('task_comments').where({ id: c.id }).update({ body, edited_at: now() });
  }
  res.redirect(back(req) + '#chat');
});

// ---------- Task chat (assignee, reviewer, leaders) ----------
r.post('/topics/:tid/tasks/:id/comments', auth.loadTopic('member'), loadTask, async (req, res) => {
  const task = req.task;
  const body = clean(req.body.body, 2000);
  if (body) {
    await db('task_comments').insert({ task_id: task.id, user_id: req.user.id, body, created_at: now() });
    const to = [task.assignee_id, task.reviewer_id || task.created_by].filter(Boolean);
    await notify(to, { kind: 'message', title: req.user.name + ' commented on “' + task.title + '”', body: body.slice(0, 140), link: back(req) + '#chat' }, req.user.id);
  }
  res.redirect(back(req) + '#chat');
});

// ---------- Review (reviewer / topic leader) ----------
r.post('/topics/:tid/tasks/:id/review', auth.loadTopic('member'), writable, loadTask, async (req, res) => {
  const t = req.topic, task = req.task;
  if (!req.isReviewer || req.isAssignee) return auth.forbidden(res, 'Only the reviewer can approve or request changes, and not on their own task.');
  if (task.status !== 'review') { req.flash('error', 'There’s nothing waiting for review.'); return res.redirect(back(req)); }
  const criteria = await db('task_criteria').where({ task_id: task.id }).orderBy('position');
  const met = new Set(list(req.body.met).map((x) => parseInt(x, 10)));
  for (const c of criteria) await db('task_criteria').where({ id: c.id }).update({ met: met.has(c.id) });
  const missing = criteria.filter((c) => !met.has(c.id)).map((c) => c.text);
  const reasons = list(req.body.reasons).map((x) => x.slice(0, 60)).slice(0, 6);
  const note = clean(req.body.note, 3000);
  const latest = await db('task_versions').where({ task_id: task.id }).orderBy('version', 'desc').first();
  if (req.body.decision === 'approve') {
    if (missing.length) { req.flash('error', 'Tick every “done when” point to approve, or request changes instead.'); return res.redirect(back(req) + '#review'); }
    if (latest) await db('task_versions').where({ id: latest.id }).update({ state: 'approved' });
    await db('tasks').where({ id: task.id }).update({ status: 'done', completed_at: now(), blocked: false, updated_at: now() });
    await log(task.id, req.user.id, 'approved', 'Approved' + (latest ? ' and locked v' + latest.version : '') + '.' + (note ? ' ' + note : ''));
    await notify(task.assignee_id, { kind: 'task', title: req.user.name + ' approved “' + task.title + '” 🎉', body: note.slice(0, 140), link: back(req) }, req.user.id);
    await audit(req.user.id, t.id, 'task.approved', 'Approved “' + task.title + '”');
    req.flash('ok', 'Approved and locked.');
  } else {
    if (!note && !reasons.length && !missing.length) { req.flash('error', 'Say what needs to change — pick a reason, untick a point or write a note.'); return res.redirect(back(req) + '#review'); }
    if (latest) await db('task_versions').where({ id: latest.id }).update({ state: 'changes' });
    await db('tasks').where({ id: task.id }).update({ status: 'changes', round: (task.round || 1) + 1, updated_at: now() });
    const detail = [note, reasons.length ? 'Reasons: ' + reasons.join(', ') : '', missing.length ? 'Not met yet: ' + missing.join('; ') : ''].filter(Boolean).join(' · ');
    await log(task.id, req.user.id, 'changes', detail);
    await notify(task.assignee_id, { kind: 'review', title: req.user.name + ' requested changes on “' + task.title + '”', body: detail.slice(0, 160), link: back(req) }, req.user.id);
    await audit(req.user.id, t.id, 'task.changes', 'Requested changes on “' + task.title + '”');
    req.flash('ok', 'Sent back with your feedback.');
  }
  res.redirect(back(req));
});

module.exports = r;
