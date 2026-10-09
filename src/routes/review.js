'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit, topicLeaders } = require('../lib/events');
const { now } = require('../lib/util');

const r = express.Router();
const MAX = parseInt(process.env.MAX_UPLOAD_MB || '10', 10) * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const crumb = (t, label) => '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / ' + label;
const BLOCKED = /\.(exe|bat|cmd|com|msi|scr|ps1|vbs|js|jar|sh|dll)$/i;

function writable(req, res, next) {
  if (req.topic.status === 'archived') { req.flash('error', 'This topic is archived and read-only.'); return res.redirect('/topics/' + req.topic.id); }
  next();
}
async function saveFile(req, folder) {
  const f = req.file;
  if (!f || !f.size) return null;
  const name = f.originalname.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 200);
  if (BLOCKED.test(name)) throw Object.assign(new Error('blocked'), { userMessage: 'That file type isn’t allowed. Upload documents, data or images.' });
  return db.insertId('files', { topic_id: req.topic.id, name, folder: clean(folder, 120) || 'General', mime: f.mimetype || 'application/octet-stream', size: f.size, data: f.buffer, uploaded_by: req.user.id, created_at: now() });
}
const isText = (f) => f && f.size < 300000 && (/^text\//.test(f.mime || '') || /\.(csv|txt|md|json|tsv)$/i.test(f.name));

// Line-level diff for comparing two text versions.
function lineDiff(a, b) {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  if (x.length * y.length > 250000) return null;
  const n = x.length, m = y.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { out.push(['=', x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]); }
  while (i < n) out.push(['-', x[i++]]); while (j < m) out.push(['+', y[j++]]);
  return out;
}

// ================= Submissions =================
r.get('/topics/:tid/submissions', auth.loadTopic(), async (req, res) => {
  const t = req.topic;
  const status = ['in_review', 'changes', 'approved'].includes(req.query.status) ? req.query.status : null;
  let q = db('submissions').leftJoin('users', 'users.id', 'submissions.created_by').where('submissions.topic_id', t.id);
  if (status) q = q.where('submissions.status', status);
  const list = await q.orderBy('submissions.updated_at', 'desc').select('submissions.*', 'users.name as author', 'users.color as author_color', 'users.id as author_id');
  const versions = list.length ? await db('submission_versions').whereIn('submission_id', list.map((s) => s.id)).groupBy('submission_id').select('submission_id').max({ v: 'version' }) : [];
  const vOf = Object.fromEntries(versions.map((x) => [x.submission_id, x.v]));
  const counts = await db('submissions').where({ topic_id: t.id }).groupBy('status').select('status').count({ n: '*' });
  res.render('pages/submissions', { title: 'Submissions · ' + t.code, active: 'topics', tab: 'Submissions', crumb: crumb(t, 'Submissions'), list, vOf, status, counts });
});
r.get('/topics/:tid/submissions/new', auth.loadTopic('member'), writable, (req, res) => {
  res.render('pages/submission-new', { title: 'New submission', active: 'topics', tab: 'Submissions', crumb: crumb(req.topic, 'New submission'), maxMb: MAX / 1024 / 1024 });
});
r.post('/topics/:tid/submissions', auth.loadTopic('member'), writable, upload.single('file'), auth.csrfAfterUpload, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title);
  if (!title || !req.file) { req.flash('error', 'Add a title and attach a file.'); return res.redirect('/topics/' + t.id + '/submissions/new'); }
  let fid;
  try { fid = await saveFile(req, 'Submissions'); } catch (e) { req.flash('error', e.userMessage || 'Upload failed.'); return res.redirect('/topics/' + t.id + '/submissions/new'); }
  const sid = await db.insertId('submissions', { topic_id: t.id, title, milestone: clean(req.body.milestone, 120), status: 'in_review', created_by: req.user.id, created_at: now(), updated_at: now() });
  await db('submission_versions').insert({ submission_id: sid, version: 1, file_id: fid, note: clean(req.body.note, 1000) || 'First version', created_by: req.user.id, created_at: now() });
  await notify(await topicLeaders(t.id), { kind: 'review', title: req.user.name + ' submitted “' + title + '”', body: t.code + ' · waiting for review', link: '/topics/' + t.id + '/submissions/' + sid }, req.user.id);
  await audit(req.user.id, t.id, 'submission.created', 'Submitted “' + title + '”');
  req.flash('ok', 'Submitted. The topic leader has been notified.');
  res.redirect('/topics/' + t.id + '/submissions/' + sid);
});
r.get('/topics/:tid/submissions/:sid', auth.loadTopic(), async (req, res) => {
  const t = req.topic;
  const s = await db('submissions').leftJoin('users', 'users.id', 'submissions.created_by').where({ 'submissions.id': parseInt(req.params.sid, 10), 'submissions.topic_id': t.id }).select('submissions.*', 'users.name as author', 'users.color as author_color', 'users.id as author_id').first();
  if (!s) return auth.notFound(res);
  const versions = await db('submission_versions').leftJoin('files', 'files.id', 'submission_versions.file_id').leftJoin('users', 'users.id', 'submission_versions.created_by')
    .where('submission_versions.submission_id', s.id).orderBy('submission_versions.version', 'desc')
    .select('submission_versions.*', 'files.name as file_name', 'files.size as file_size', 'files.mime', 'files.id as fid', 'users.name as by');
  const reviews = await db('reviews').leftJoin('users', 'users.id', 'reviews.reviewer_id').where('reviews.submission_id', s.id).orderBy('reviews.id', 'desc').select('reviews.*', 'users.name', 'users.color', 'users.id as uid');
  // Compare the latest two versions when both are text
  let diff = null, preview = null;
  const ids = versions.slice(0, 2).map((v) => v.fid).filter(Boolean);
  const files = ids.length ? await db('files').whereIn('id', ids).select('id', 'name', 'mime', 'size', 'data') : [];
  const fOf = Object.fromEntries(files.map((f) => [f.id, f]));
  const latest = versions[0] && fOf[versions[0].fid];
  if (isText(latest)) preview = Buffer.from(latest.data).toString('utf8');
  if (versions[1] && isText(latest) && isText(fOf[versions[1].fid])) diff = lineDiff(Buffer.from(fOf[versions[1].fid].data).toString('utf8'), preview);
  const canReview = res.locals.isTopicLeader && s.created_by !== req.user.id;
  res.render('pages/submission', { title: s.title, active: 'topics', tab: 'Submissions', crumb: crumb(t, '<a href="/topics/' + t.id + '/submissions">Submissions</a> / #' + s.id), s, versions, reviews, diff, preview, canReview, isAuthor: s.created_by === req.user.id, maxMb: MAX / 1024 / 1024 });
});
r.post('/topics/:tid/submissions/:sid/version', auth.loadTopic('member'), writable, upload.single('file'), auth.csrfAfterUpload, async (req, res) => {
  const t = req.topic;
  const s = await db('submissions').where({ id: parseInt(req.params.sid, 10), topic_id: t.id }).first();
  if (!s) return auth.notFound(res);
  if (s.created_by !== req.user.id && req.topicRole !== 'leader') return auth.forbidden(res, 'Only the author can upload a new version.');
  if (s.status === 'approved') { req.flash('error', 'Approved submissions are locked. Start a new submission for further changes.'); return res.redirect('/topics/' + t.id + '/submissions/' + s.id); }
  if (!req.file) { req.flash('error', 'Attach the new version.'); return res.redirect('/topics/' + t.id + '/submissions/' + s.id); }
  let fid;
  try { fid = await saveFile(req, 'Submissions'); } catch (e) { req.flash('error', e.userMessage || 'Upload failed.'); return res.redirect('/topics/' + t.id + '/submissions/' + s.id); }
  const last = await db('submission_versions').where({ submission_id: s.id }).max({ v: 'version' }).first();
  const v = (Number(last.v) || 0) + 1;
  await db('submission_versions').insert({ submission_id: s.id, version: v, file_id: fid, note: clean(req.body.note, 1000), created_by: req.user.id, created_at: now() });
  await db('submissions').where({ id: s.id }).update({ status: 'in_review', updated_at: now() });
  await notify(await topicLeaders(t.id), { kind: 'review', title: req.user.name + ' uploaded v' + v + ' of “' + s.title + '”', body: t.code, link: '/topics/' + t.id + '/submissions/' + s.id }, req.user.id);
  await audit(req.user.id, t.id, 'submission.version', 'Uploaded v' + v + ' of “' + s.title + '”');
  req.flash('ok', 'Version ' + v + ' uploaded and sent for review.');
  res.redirect('/topics/' + t.id + '/submissions/' + s.id);
});
r.post('/topics/:tid/submissions/:sid/review', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const s = await db('submissions').where({ id: parseInt(req.params.sid, 10), topic_id: t.id }).first();
  if (!s) return auth.notFound(res);
  if (s.created_by === req.user.id) return auth.forbidden(res, 'You can’t review your own submission. Ask a co-leader.');
  const decision = ['approved', 'changes', 'comment'].includes(req.body.decision) ? req.body.decision : 'comment';
  const comment = clean(req.body.comment, 4000);
  if (decision !== 'approved' && !comment) { req.flash('error', 'Add a comment so the author knows what to change.'); return res.redirect('/topics/' + t.id + '/submissions/' + s.id); }
  await db('reviews').insert({ submission_id: s.id, reviewer_id: req.user.id, decision, comment, created_at: now() });
  if (decision !== 'comment') await db('submissions').where({ id: s.id }).update({ status: decision, reviewer_id: req.user.id, updated_at: now() });
  const label = { approved: 'approved', changes: 'requested changes on', comment: 'commented on' }[decision];
  await notify(s.created_by, { kind: 'review', title: req.user.name + ' ' + label + ' “' + s.title + '”', body: comment.slice(0, 140), link: '/topics/' + t.id + '/submissions/' + s.id }, req.user.id);
  await audit(req.user.id, t.id, 'submission.' + decision, req.user.name + ' ' + label + ' “' + s.title + '”');
  req.flash('ok', decision === 'approved' ? 'Approved and locked.' : decision === 'changes' ? 'Changes requested. The author was notified.' : 'Comment added.');
  res.redirect('/topics/' + t.id + '/submissions/' + s.id);
});

// ================= Files =================
r.get('/topics/:tid/files', auth.loadTopic(), async (req, res) => {
  const t = req.topic;
  const folder = req.query.folder ? clean(req.query.folder, 120) : null;
  let q = db('files').leftJoin('users', 'users.id', 'files.uploaded_by').where('files.topic_id', t.id);
  if (folder) q = q.where('files.folder', folder);
  const files = await q.orderBy('files.id', 'desc').select('files.id', 'files.name', 'files.folder', 'files.mime', 'files.size', 'files.created_at', 'files.uploaded_by', 'users.name as by');
  const folders = await db('files').where({ topic_id: t.id }).groupBy('folder').select('folder').count({ n: '*' }).orderBy('folder');
  const total = await db('files').where({ topic_id: t.id }).sum({ s: 'size' }).first();
  res.render('pages/files', { title: 'Files · ' + t.code, active: 'topics', tab: 'Files', crumb: crumb(t, 'Files'), files, folders, folder, totalSize: Number(total.s) || 0, maxMb: MAX / 1024 / 1024 });
});
r.post('/topics/:tid/files', auth.loadTopic('member'), writable, upload.single('file'), auth.csrfAfterUpload, async (req, res) => {
  const t = req.topic;
  if (!req.file) { req.flash('error', 'Choose a file to upload.'); return res.redirect('/topics/' + t.id + '/files'); }
  try {
    await saveFile(req, req.body.folder || 'General');
    await audit(req.user.id, t.id, 'file.uploaded', 'Uploaded ' + req.file.originalname);
    req.flash('ok', req.file.originalname + ' uploaded.');
  } catch (e) { req.flash('error', e.userMessage || 'Upload failed.'); }
  res.redirect('/topics/' + t.id + '/files');
});
r.get('/topics/:tid/files/:fid', auth.loadTopic(), async (req, res) => {
  const f = await db('files').where({ id: parseInt(req.params.fid, 10), topic_id: req.topic.id }).first();
  if (!f) return auth.notFound(res);
  const inline = req.query.view === '1' && (/^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain|text\/csv)$/.test(f.mime || ''));
  res.set('Content-Type', inline ? f.mime : 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.set('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + f.name.replace(/[^\w.\- ]+/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name));
  res.send(Buffer.from(f.data));
});
r.post('/topics/:tid/files/:fid/delete', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const f = await db('files').where({ id: parseInt(req.params.fid, 10), topic_id: t.id }).first();
  if (!f) return auth.notFound(res);
  if (f.uploaded_by !== req.user.id && req.topicRole !== 'leader') return auth.forbidden(res, 'Only the uploader or a leader can delete this file.');
  const used = await db('submission_versions').where({ file_id: f.id }).first();
  if (used) { req.flash('error', 'This file is part of a submission and can’t be deleted.'); return res.redirect('/topics/' + t.id + '/files'); }
  await db('files').where({ id: f.id }).del();
  await audit(req.user.id, t.id, 'file.deleted', 'Deleted ' + f.name);
  req.flash('ok', f.name + ' deleted.');
  res.redirect('/topics/' + t.id + '/files');
});

module.exports = r;
