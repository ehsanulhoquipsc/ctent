'use strict';
// Step 6 · Publish: the Style library (admins) and the Publish studio (project leaders; members can read).
const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../lib/auth');
const llm = require('../lib/llm');
const { audit } = require('../lib/events');
const { now } = require('../lib/util');
const pub = require('../lib/publish');

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const clean = (v, max) => String(v || '').trim().slice(0, max || 160);
const PROOF_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp)|text\/plain|message\/rfc822|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/msword)$/;
// Samples are pasted one after another, separated by a line with three dashes.
const splitSamples = (text) => String(text || '').replace(/\r/g, '').split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 40).slice(0, 5);

// ---------- Style library (admins) ----------
r.use('/admin/styles', auth.requireRole('admin'));
r.get('/admin/styles', async (req, res) => {
  const styles = await db('styles').leftJoin('users', 'users.id', 'styles.created_by').orderBy('styles.name').select('styles.id', 'styles.name', 'styles.rights', 'styles.died_year', 'styles.card', 'styles.metrics', 'styles.proof_name', 'styles.created_at', 'users.name as by');
  const used = await db('publish_runs').whereNotNull('style_id').groupBy('style_id').select('style_id').count({ n: '*' });
  const uses = Object.fromEntries(used.map((x) => [x.style_id, Number(x.n)]));
  res.render('pages/styles', { needBn: true, title: 'Writing styles', active: 'admin', styles: styles.map((s) => ({ ...s, metrics: JSON.parse(s.metrics || '{}'), uses: uses[s.id] || 0 })), form: null, error: null, aiOn: llm.available(), minYear: new Date().getFullYear() - 61 });
});

r.post('/admin/styles', upload.single('proof'), auth.csrfAfterUpload, async (req, res) => {
  const v = { name: clean(req.body.name, 120), rights: req.body.rights === 'classic' ? 'classic' : 'permission', died_year: parseInt(req.body.died_year, 10) || null, samples: String(req.body.samples || '').slice(0, 60000) };
  const samples = splitSamples(v.samples);
  let error = null;
  if (v.name.length < 2) error = 'Enter the writer’s name.';
  else if (v.rights === 'classic' && !pub.classicOk(v.died_year)) error = 'Classic writers must have died more than 60 years ago (in or before ' + (new Date().getFullYear() - 61) + '). Otherwise their work is still under copyright — choose “Permission given” and upload their OK.';
  else if (v.rights === 'permission' && !req.file) error = 'Upload the writer’s written permission (a letter, email or message as PDF, image, Word or text).';
  else if (req.file && !PROOF_TYPES.test(req.file.mimetype)) error = 'The permission file must be a PDF, image, Word or text file.';
  else if (!samples.length) error = 'Add at least one writing sample of 40 words or more. Separate samples with a line of three dashes (---).';
  if (error) {
    const styles = await db('styles').orderBy('name').select('id', 'name', 'rights', 'died_year', 'card', 'metrics', 'proof_name', 'created_at');
    return res.status(400).render('pages/styles', { needBn: true, title: 'Writing styles', active: 'admin', styles: styles.map((s) => ({ ...s, metrics: JSON.parse(s.metrics || '{}'), uses: 0 })), form: v, error, aiOn: llm.available(), minYear: new Date().getFullYear() - 61 });
  }
  const learned = await pub.styleCard(samples);
  const id = await db.insertId('styles', {
    name: v.name, rights: v.rights, died_year: v.rights === 'classic' ? v.died_year : null,
    proof_name: req.file ? clean(req.file.originalname, 200) : null, proof_type: req.file ? req.file.mimetype : null, proof_data: req.file ? req.file.buffer : null,
    samples: JSON.stringify(samples), card: learned.card, metrics: JSON.stringify(learned.metrics), examples: JSON.stringify(learned.examples),
    created_by: req.user.id, created_at: now(), updated_at: now()
  });
  await audit(req.user.id, null, 'style.add', 'Added the writing style “' + v.name + '” (' + (v.rights === 'classic' ? 'classic writer, died ' + v.died_year : 'permission given') + ')');
  req.flash('ok', 'Style added. Check the style card — you can edit it.');
  res.redirect('/admin/styles/' + id);
});

async function loadStyle(req, res, next) {
  const s = await db('styles').where({ id: parseInt(req.params.id, 10) || 0 }).first();
  if (!s) return auth.notFound(res);
  req.style = s; next();
}
r.get('/admin/styles/:id', loadStyle, async (req, res) => {
  const s = req.style;
  res.render('pages/style', { needBn: true, title: s.name, active: 'admin', s: { ...s, samples: JSON.parse(s.samples || '[]'), metrics: JSON.parse(s.metrics || '{}'), examples: JSON.parse(s.examples || '[]') }, aiOn: llm.available() });
});
r.post('/admin/styles/:id', loadStyle, async (req, res) => {
  const card = clean(req.body.card, 3000);
  const name = clean(req.body.name, 120);
  if (card.length < 20 || name.length < 2) { req.flash('error', 'Keep a name and a style card of a sentence or more.'); return res.redirect('/admin/styles/' + req.style.id); }
  await db('styles').where({ id: req.style.id }).update({ card, name, updated_at: now() });
  req.flash('ok', 'Style saved.');
  res.redirect('/admin/styles/' + req.style.id);
});
r.post('/admin/styles/:id/relearn', loadStyle, async (req, res) => {
  const learned = await pub.styleCard(JSON.parse(req.style.samples || '[]'));
  await db('styles').where({ id: req.style.id }).update({ card: learned.card, metrics: JSON.stringify(learned.metrics), examples: JSON.stringify(learned.examples), updated_at: now() });
  req.flash('ok', 'The style card was written again from the samples.');
  res.redirect('/admin/styles/' + req.style.id);
});
r.post('/admin/styles/:id/delete', loadStyle, async (req, res) => {
  await db('styles').where({ id: req.style.id }).del();
  await audit(req.user.id, null, 'style.delete', 'Deleted the writing style “' + req.style.name + '” and its samples');
  req.flash('ok', 'Style deleted, with its samples and permission file. Versions already written are kept.');
  res.redirect('/admin/styles');
});
r.get('/admin/styles/:id/proof', loadStyle, (req, res) => {
  if (!req.style.proof_data) return auth.notFound(res);
  res.set('Content-Type', req.style.proof_type || 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="' + String(req.style.proof_name || 'permission').replace(/["\\\r\n]/g, '') + '"');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(req.style.proof_data);
});

// ---------- Publish studio (per project) ----------
function canEdit(req) { return req.topicRole === 'leader' || req.user.platform_role === 'admin'; }
function writable(req, res, next) {
  if (!canEdit(req)) return auth.forbidden(res, 'Only the project leader can do this.');
  if (req.topic.status === 'archived') { req.flash('error', 'This project is archived and read-only.'); return res.redirect('/topics/' + req.topic.id + '/publish'); }
  next();
}
async function outputsOf(runId) {
  const outs = await db('publish_outputs').where({ run_id: runId }).orderBy('id');
  const claims = outs.length ? await db('publish_claims').whereIn('output_id', outs.map((o) => o.id)).orderBy('id') : [];
  return outs.map((o) => ({ ...o, claims: claims.filter((c) => c.output_id === o.id) }));
}

r.get('/topics/:tid/publish', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const runs = await db('publish_runs').where({ topic_id: t.id }).orderBy('id', 'desc').limit(20);
  const pick = parseInt(req.query.run, 10);
  const run = (pick && runs.find((x) => x.id === pick)) || runs[0] || null;
  const [styles, ready, src] = await Promise.all([db('styles').orderBy('name').select('id', 'name', 'rights', 'died_year', 'card'), pub.ready(t), pub.sourceOf(t)]);
  const outputs = run ? await outputsOf(run.id) : [];
  const tab = ['fb', 'web_en', 'web_bn'].includes(req.query.tab) ? req.query.tab : (outputs[0] ? outputs[0].format : 'fb');
  res.render('pages/publish', {
    needBn: true, title: 'Publish · ' + t.code, active: 'topics', tab: 'Publish', topic: t, canEdit: canEdit(req), aiOn: llm.available(),
    styles, ready, words: src.words, refs: src.refs, runs, run, outputs, view: tab, settings: run ? JSON.parse(run.settings || '{}') : {},
    FORMATS: pub.FORMATS, LENGTHS: pub.LENGTHS, READERS: pub.READERS, html: (o) => pub.articleHtml(o, src.refs), text: (o) => pub.articleText(o, src.refs)
  });
});

r.post('/topics/:tid/publish', auth.loadTopic('member'), writable, async (req, res) => {
  const t = req.topic;
  const back = '/topics/' + t.id + '/publish';
  if (!llm.available()) { req.flash('error', 'No AI service is connected, so the Publish agent can’t write. Ask your admin to add an AI key.'); return res.redirect(back); }
  if (!(await pub.ready(t))) { req.flash('error', 'Write the final paper first — the public versions are made from it.'); return res.redirect(back); }
  const style = await db('styles').where({ id: parseInt(req.body.style_id, 10) || 0 }).first();
  if (!style) { req.flash('error', 'Choose a writing style.'); return res.redirect(back); }
  const formats = ['fb', 'web_en', 'web_bn'].filter((f) => [].concat(req.body.formats || []).includes(f));
  if (!formats.length) { req.flash('error', 'Choose at least one thing to make.'); return res.redirect(back); }
  if (await db('publish_runs').where({ topic_id: t.id }).whereIn('status', ['queued', 'running']).first()) { req.flash('error', 'The agent is already writing for this project. Wait for it to finish.'); return res.redirect(back); }
  const settings = {
    formats, reader: pub.READERS[req.body.reader] ? req.body.reader : 'public', length: pub.LENGTHS[req.body.length] ? req.body.length : 'full',
    link: clean(req.body.link, 200) || 'doctren.com', hashtags: clean(req.body.hashtags, 200).split(/\s+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h)).slice(0, 5).join(' ')
  };
  const id = await db.insertId('publish_runs', { topic_id: t.id, style_id: style.id, style_name: style.name, settings: JSON.stringify(settings), status: 'queued', step: 'Waiting to start', progress: 0, created_by: req.user.id, created_at: now() });
  await audit(req.user.id, t.id, 'publish.run', 'Started writing public versions in the ' + style.name + ' style');
  pub.start(id);
  res.redirect(back + '?run=' + id);
});

r.get('/topics/:tid/publish/runs/:rid.json', auth.loadTopic('member'), async (req, res) => {
  const run = await db('publish_runs').where({ id: parseInt(req.params.rid, 10) || 0, topic_id: req.topic.id }).first();
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ status: run.status, step: run.step, progress: run.progress, error: run.error });
});

async function loadOutput(req, res, next) {
  const o = await db('publish_outputs').join('publish_runs', 'publish_runs.id', 'publish_outputs.run_id').where('publish_outputs.id', parseInt(req.params.oid, 10) || 0).where('publish_runs.topic_id', req.topic.id).select('publish_outputs.*').first();
  if (!o) return auth.notFound(res);
  req.output = o; req.run = await db('publish_runs').where({ id: o.run_id }).first();
  next();
}
const backTo = (req) => '/topics/' + req.topic.id + '/publish?run=' + req.run.id + '&tab=' + req.output.format;

r.post('/topics/:tid/publish/outputs/:oid', auth.loadTopic('member'), writable, loadOutput, async (req, res) => {
  const body = String(req.body.body || '').replace(/\r/g, '').slice(0, 40000).trim();
  if (!body) { req.flash('error', 'The text can’t be empty.'); return res.redirect(backTo(req)); }
  const upd = { body, edited: true, updated_by: req.user.id, updated_at: now() };
  if (req.output.format !== 'fb') { upd.title = clean(req.body.title, 300); upd.subtitle = clean(req.body.subtitle, 500); }
  await db('publish_outputs').where({ id: req.output.id }).update(upd);
  await pub.quickCheck({ ...req.output, ...upd }, req.run);
  req.flash('ok', 'Saved and checked again.');
  res.redirect(backTo(req));
});

r.post('/topics/:tid/publish/outputs/:oid/revise', auth.loadTopic('member'), writable, loadOutput, async (req, res) => {
  if (!llm.available()) { req.flash('error', 'No AI service is connected.'); return res.redirect(backTo(req)); }
  try {
    if (req.body.how === 'check') await pub.quickCheck(req.output, req.run);
    else await pub.revise(req.output, req.run, { kind: 'length', dir: req.body.how === 'longer' ? 'longer' : 'shorter' });
    req.flash('ok', req.body.how === 'check' ? 'Checked again against the final paper.' : 'Rewritten ' + (req.body.how === 'longer' ? 'longer' : 'shorter') + ' and checked again.');
  } catch (e) { req.flash('error', 'The agent couldn’t do that: ' + e.message); }
  res.redirect(backTo(req));
});

r.get('/topics/:tid/publish/outputs/:oid/word', auth.loadTopic('member'), loadOutput, async (req, res) => {
  if (req.output.format === 'fb') return auth.notFound(res);
  const src = await pub.sourceOf(req.topic);
  const buf = await pub.articleDocx(req.output, src.refs);
  const name = (req.topic.code + ' ' + (req.output.format === 'web_bn' ? 'Bangla' : 'English') + ' article').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') + '.docx';
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', 'attachment; filename="' + name + '"');
  res.send(buf);
});

r.post('/topics/:tid/publish/claims/:cid', auth.loadTopic('member'), async (req, res, next) => {
  const c = await db('publish_claims').where({ id: parseInt(req.params.cid, 10) || 0 }).first();
  if (!c) return auth.notFound(res);
  req.params.oid = String(c.output_id); req.claim = c;
  next();
}, writable, loadOutput, async (req, res) => {
  const c = req.claim;
  const action = req.body.action;
  try {
    if (action === 'remove') {
      if (!req.output.body.includes(c.quote)) throw new Error('That sentence isn’t in the text any more.');
      const body = req.output.body.replace(c.quote, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      await db('publish_outputs').where({ id: req.output.id }).update({ body, edited: true, updated_by: req.user.id, updated_at: now() });
      await db('publish_claims').where({ id: c.id }).update({ resolved: true });
      req.flash('ok', 'Sentence removed.');
    } else if (action === 'rewrite') {
      if (!llm.available()) throw new Error('No AI service is connected.');
      await pub.revise(req.output, req.run, { kind: 'fix', quote: c.quote, fact: c.fact });
      req.flash('ok', 'Sentence rewritten to match the final paper, and checked again.');
    } else if (action === 'keep') {
      await db('publish_claims').where({ id: c.id }).update({ resolved: true });
      req.flash('ok', 'Marked as checked by you.');
    }
  } catch (e) { req.flash('error', e.message); }
  res.redirect(backTo(req));
});

module.exports = r;
