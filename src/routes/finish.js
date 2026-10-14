'use strict';
// Finishing a project: a celebration page where a leader picks the final report, kept with the topic for later.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit } = require('../lib/events');
const { now, toDate } = require('../lib/util');

const r = express.Router();
const MAX = parseInt(process.env.MAX_UPLOAD_MB || '10', 10) * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });
const BLOCKED = /\.(exe|bat|cmd|com|msi|scr|ps1|vbs|js|jar|sh|dll)$/i;
const clean = (v, max) => String(v || '').trim().slice(0, max || 200);
const crumb = (t) => '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / ' + (t.status === 'completed' ? 'Final report' : 'Finish project');

// Files that could be the final report, best candidates first.
async function candidates(topicId) {
  const latest = await db('submission_versions').join('submissions', 'submissions.id', 'submission_versions.submission_id').join('files', 'files.id', 'submission_versions.file_id')
    .where('submissions.topic_id', topicId).orderBy('submission_versions.version', 'desc')
    .select('submissions.id as sid', 'submissions.title', 'submissions.status', 'submission_versions.version', 'files.id', 'files.name', 'files.size', 'files.created_at');
  const seenSub = new Set(), seen = new Set(), groups = { approved: [], task: [], subs: [], other: [] };
  for (const v of latest) {
    if (seenSub.has(v.sid)) continue; seenSub.add(v.sid); seen.add(v.id);
    (v.status === 'approved' ? groups.approved : groups.subs).push({ id: v.id, name: v.name, size: v.size, created_at: v.created_at, label: v.title + ' · v' + v.version, status: v.status });
  }
  const taskWork = await db('task_versions').join('tasks', 'tasks.id', 'task_versions.task_id').join('files', 'files.id', 'task_versions.file_id')
    .where('tasks.topic_id', topicId).where('task_versions.state', 'approved').orderBy('task_versions.id', 'desc')
    .select('tasks.title', 'task_versions.version', 'files.id', 'files.name', 'files.size', 'files.created_at');
  for (const v of taskWork) if (!seen.has(v.id)) { seen.add(v.id); groups.task.push({ id: v.id, name: v.name, size: v.size, created_at: v.created_at, label: 'Task: ' + v.title + ' · v' + v.version }); }
  const files = await db('files').where({ topic_id: topicId }).orderBy('id', 'desc').limit(150).select('id', 'name', 'size', 'folder', 'created_at');
  for (const f of files) if (!seen.has(f.id)) { seen.add(f.id); groups.other.push({ id: f.id, name: f.name, size: f.size, created_at: f.created_at, label: f.folder || 'Files' }); }
  return groups;
}

async function summary(t) {
  const tasks = await db('tasks').where({ topic_id: t.id }).select('id', 'title', 'status', 'assignee_id');
  const done = tasks.filter((x) => x.status === 'done');
  const subsApproved = Number((await db('submissions').where({ topic_id: t.id, status: 'approved' }).count({ n: '*' }).first()).n);
  const meetings = Number((await db('meetings').where({ topic_id: t.id }).count({ n: '*' }).first()).n);
  const team = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', t.id).whereNot('topic_members.role', 'guest')
    .orderByRaw("case topic_members.role when 'leader' then 0 else 1 end").orderBy('users.name').select('users.id', 'users.name', 'users.color', 'users.title', 'topic_members.role');
  const doneBy = {};
  done.forEach((x) => { if (x.assignee_id) doneBy[x.assignee_id] = (doneBy[x.assignee_id] || 0) + 1; });
  const start = toDate(t.created_at), end = t.completed_at ? toDate(t.completed_at) : new Date();
  return { total: tasks.length, done: done.length, open: tasks.filter((x) => x.status !== 'done'), subsApproved, meetings, team: team.map((m) => ({ ...m, doneCount: doneBy[m.id] || 0 })), days: start ? Math.max(1, Math.round((end - start) / 86400000)) : null };
}

r.get('/topics/:tid/finish', auth.loadTopic(), async (req, res) => {
  const t = req.topic;
  const leader = req.topicRole === 'leader';
  if (t.status !== 'completed' && !leader) return res.redirect('/topics/' + t.id);
  const sum = await summary(t);
  const final = t.final_file_id ? await db('files').where({ id: t.final_file_id, topic_id: t.id }).select('id', 'name', 'size', 'mime', 'created_at').first() : null;
  const by = t.completed_by ? await db('users').where({ id: t.completed_by }).select('id', 'name', 'color').first() : null;
  res.render('pages/finish', { title: (t.status === 'completed' ? 'Final report · ' : 'Finish · ') + t.code, active: 'topics', tab: 'Overview', crumb: crumb(t), sum, final, by,
    groups: leader ? await candidates(t.id) : null, maxMb: MAX / 1024 / 1024, preselect: parseInt(req.query.file, 10) || null });
});

r.post('/topics/:tid/finish', auth.loadTopic('leader'), upload.single('file'), auth.csrfAfterUpload, async (req, res) => {
  const t = req.topic;
  if (t.status === 'archived') { req.flash('error', 'Reopen the topic first.'); return res.redirect('/topics/' + t.id + '/settings'); }
  let fileId = null;
  if (req.file && req.file.size) {
    const name = req.file.originalname.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 200);
    if (BLOCKED.test(name)) { req.flash('error', 'That file type isn’t allowed.'); return res.redirect('/topics/' + t.id + '/finish'); }
    fileId = await db.insertId('files', { topic_id: t.id, name, folder: 'Final report', mime: req.file.mimetype || 'application/octet-stream', size: req.file.size, data: req.file.buffer, uploaded_by: req.user.id, created_at: now() });
  } else {
    const f = await db('files').where({ id: parseInt(req.body.file_id, 10) || 0, topic_id: t.id }).first();
    if (f) fileId = f.id;
  }
  if (!fileId) { req.flash('error', 'Choose the final report from the list, or upload it.'); return res.redirect('/topics/' + t.id + '/finish#report'); }
  const file = await db('files').where({ id: fileId }).first();
  const first = t.status !== 'completed';
  await db('topics').where({ id: t.id }).update({
    status: 'completed', final_file_id: fileId, final_title: clean(req.body.final_title) || file.name, final_note: clean(req.body.final_note, 3000) || null,
    completed_at: first ? now() : t.completed_at, completed_by: first ? req.user.id : t.completed_by
  });
  if (first) {
    const everyone = (await db('topic_members').where({ topic_id: t.id }).select('user_id')).map((x) => x.user_id);
    await notify(everyone, { kind: 'task', title: '🎉 ' + t.code + ' is complete!', body: 'Final report: ' + (clean(req.body.final_title) || file.name), link: '/topics/' + t.id + '/finish' }, req.user.id);
    await audit(req.user.id, t.id, 'topic.completed', 'Finished the project. Final report: ' + file.name);
    req.flash('ok', 'Congratulations! The project is complete and the final report is saved with it.');
  } else {
    await audit(req.user.id, t.id, 'topic.final_report', 'Changed the final report to ' + file.name);
    req.flash('ok', 'Final report updated.');
  }
  res.redirect('/topics/' + t.id + '/finish');
});

r.post('/topics/:tid/finish/reopen', auth.loadTopic('leader'), async (req, res) => {
  const t = req.topic;
  if (t.status !== 'completed') return res.redirect('/topics/' + t.id);
  await db('topics').where({ id: t.id }).update({ status: 'active' });
  await audit(req.user.id, t.id, 'topic.reopened', 'Reopened ' + t.code + ' (final report kept)');
  req.flash('ok', t.code + ' reopened. The final report is kept until you finish again.');
  res.redirect('/topics/' + t.id);
});

module.exports = r;
