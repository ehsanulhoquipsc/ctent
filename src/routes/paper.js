'use strict';
// The final paper: one section per part (plus introduction and conclusion), built from accepted findings.
// Citations are stored in the text as [src:ID] markers and numbered in order of first use.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const llm = require('../lib/llm');
const agent = require('../lib/agent');
const { audit, notify, topicLeaders } = require('../lib/events');
const { now, esc } = require('../lib/util');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const crumb = (t, label) => '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / ' + label;
const MARK = /\[src:(\d+)\]/g;
function writable(req, res, next) {
  if (req.topic.status === 'archived') { req.flash('error', 'This topic is archived and read-only.'); return res.redirect('/topics/' + req.topic.id); }
  next();
}

// Make sure every part has a section, between the introduction and the conclusion.
async function ensureSections(topic) {
  let secs = await db('paper_sections').where({ topic_id: topic.id }).orderBy('position').orderBy('id');
  const parts = await db('parts').where({ topic_id: topic.id }).orderBy('position').orderBy('id');
  if (!secs.length) {
    const rows = [{ title: 'Abstract' }, { title: 'Introduction' }, ...parts.map((p) => ({ title: p.title, part_id: p.id })), { title: 'Conclusion' }];
    await db('paper_sections').insert(rows.map((x, i) => ({ topic_id: topic.id, title: x.title.slice(0, 240), part_id: x.part_id || null, position: (i + 1) * 10, body: '', updated_at: now() })));
  } else {
    const have = new Set(secs.map((s) => s.part_id).filter(Boolean));
    const missing = parts.filter((p) => !have.has(p.id));
    if (missing.length) {
      const concl = secs.find((s) => /^conclusion/i.test(s.title));
      let pos = concl ? concl.position - missing.length : (secs[secs.length - 1].position + 10);
      for (const p of missing) await db('paper_sections').insert({ topic_id: topic.id, title: p.title.slice(0, 240), part_id: p.id, position: pos++, body: '', updated_at: now() });
    }
  }
  secs = await db('paper_sections').where({ topic_id: topic.id }).orderBy('position').orderBy('id');
  return secs;
}

// Accepted, kept findings with the database ids of the sources they cite.
async function acceptedFindings(topicId, partIds) {
  let q = db('parts').where({ topic_id: topicId, agent_status: 'accepted' });
  if (partIds) q = q.whereIn('id', partIds);
  const parts = await q.select('id', 'title', 'agent_name');
  const out = [];
  for (const p of parts) {
    const run = await db('agent_runs').where({ part_id: p.id, status: 'done' }).orderBy('id', 'desc').first();
    if (!run) continue;
    const [fs, ss] = await Promise.all([db('agent_findings').where({ run_id: run.id, kept: true }).orderBy('position'), db('agent_sources').where({ run_id: run.id }).select('id', 'n')]);
    const idOf = Object.fromEntries(ss.map((s) => [s.n, s.id]));
    fs.forEach((f) => {
      const ids = String(f.cites || '').split(',').map((x) => idOf[parseInt(x, 10)]).filter(Boolean);
      out.push({ ...f, part: p, srcIds: ids, marks: ids.map((id) => '[src:' + id + ']').join('') });
    });
  }
  return out;
}

function harvard(s) {
  if (!s) return 'Source removed';
  const who = s.kind === 'wiki' ? 'Wikipedia contributors' : (s.authors || 'Unknown author');
  return who + ' (' + (s.year || 'n.d.') + ') ' + (s.kind === 'wiki' ? s.title.replace(/ \(Wikipedia\)$/, '') : '‘' + s.title + '’') + (s.venue && s.kind !== 'wiki' ? ', ' + s.venue : '') + '.' + (s.doi ? ' doi:' + s.doi + '.' : s.url ? ' Available at: ' + s.url + '.' : '');
}

// Number citations in order of first use across all sections.
async function numbering(sections) {
  const order = [];
  sections.forEach((s) => { for (const m of String(s.body || '').matchAll(MARK)) { const id = parseInt(m[1], 10); if (!order.includes(id)) order.push(id); } });
  const rows = order.length ? await db('agent_sources').whereIn('id', order) : [];
  const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
  return { num: Object.fromEntries(order.map((id, i) => [id, i + 1])), refs: order.map((id, i) => ({ n: i + 1, id, text: harvard(byId[id]), url: byId[id] && byId[id].url })) };
}
function renderBody(body, num) {
  const paras = String(body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => '<p>' + esc(p).replace(/(?:\[src:(\d+)\])+/g, (all) => {
    const ns = [...all.matchAll(/\[src:(\d+)\]/g)].map((m) => num[parseInt(m[1], 10)]).filter(Boolean);
    return ns.length ? '<sup class="ref">[' + ns.map((n) => '<a href="#ref' + n + '">' + n + '</a>').join(', ') + ']</sup>' : '';
  }).replace(/\n/g, '<br>') + '</p>').join('');
}
const plain = (body, num) => String(body || '').replace(/(?:\[src:(\d+)\])+/g, (all) => { const ns = [...all.matchAll(/\[src:(\d+)\]/g)].map((m) => num[parseInt(m[1], 10)]).filter(Boolean); return ns.length ? ' [' + ns.join(', ') + ']' : ''; });
const words = (sections) => sections.reduce((a, s) => a + String(s.body || '').replace(MARK, '').split(/\s+/).filter(Boolean).length, 0);

r.get('/topics/:tid/paper', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const sections = await ensureSections(t);
  const cur = sections.find((s) => s.id === parseInt(req.query.s, 10)) || sections.find((s) => s.part_id) || sections[0];
  const { num, refs } = await numbering(sections);
  const parts = await db('parts').where({ topic_id: t.id }).select('id', 'title', 'agent_status', 'agent_name');
  const partOf = Object.fromEntries(parts.map((p) => [p.id, p]));
  const findings = await acceptedFindings(t.id, cur.part_id ? [cur.part_id] : null);
  const used = new Set();
  sections.forEach((s) => { String(s.body || '').split(/\n\s*\n/).forEach((p) => used.add(p.replace(MARK, '').trim())); });
  const comments = await db('paper_comments').leftJoin('users', 'users.id', 'paper_comments.user_id').where('paper_comments.section_id', cur.id).orderBy('paper_comments.id').select('paper_comments.*', 'users.name', 'users.color', 'users.id as uid');
  res.render('pages/paper', { title: 'Final paper · ' + t.code, active: 'topics', tab: 'Final paper', crumb: crumb(t, 'Final paper'),
    sections: sections.map((s) => ({ ...s, part: s.part_id ? partOf[s.part_id] : null, filled: !!String(s.body || '').trim() })), cur: { ...cur, part: cur.part_id ? partOf[cur.part_id] : null, html: renderBody(cur.body, num) },
    findings: findings.map((f) => ({ ...f, used: used.has(f.text.trim()) })), refs, comments, wordCount: words(sections), aiOn: llm.available(),
    accepted: parts.filter((p) => p.agent_status === 'accepted').length, partCount: parts.length, editing: req.query.edit === '1' });
});

async function loadSection(req, res, next) {
  const s = await db('paper_sections').where({ id: parseInt(req.params.sid, 10), topic_id: req.topic.id }).first();
  if (!s) return auth.notFound(res, 'That section doesn’t exist.');
  req.section = s;
  next();
}
const back = (t, s, extra) => '/topics/' + t.id + '/paper?s=' + s.id + (extra || '');

r.post('/topics/:tid/paper/sections', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title);
  if (!title) { req.flash('error', 'Give the section a title.'); return res.redirect('/topics/' + t.id + '/paper'); }
  const secs = await ensureSections(t);
  const concl = secs.find((s) => /^conclusion/i.test(s.title));
  const pos = concl ? concl.position - 1 : secs[secs.length - 1].position + 10;
  const id = await db.insertId('paper_sections', { topic_id: t.id, title, position: pos, body: '', updated_by: req.user.id, updated_at: now() });
  res.redirect('/topics/' + t.id + '/paper?s=' + id + '&edit=1');
});
r.post('/topics/:tid/paper/sections/:sid', auth.loadTopic('leader'), writable, loadSection, async (req, res) => {
  const t = req.topic, s = req.section, action = req.body.action;
  if (action === 'delete') {
    await db('paper_sections').where({ id: s.id }).del();
    req.flash('ok', 'Section deleted.');
    return res.redirect('/topics/' + t.id + '/paper');
  }
  if (action === 'up' || action === 'down') {
    const secs = await db('paper_sections').where({ topic_id: t.id }).orderBy('position').orderBy('id');
    const i = secs.findIndex((x) => x.id === s.id), j = action === 'up' ? i - 1 : i + 1;
    if (secs[j]) {
      const order = secs.map((x) => x.id); [order[i], order[j]] = [order[j], order[i]];
      for (let k = 0; k < order.length; k++) await db('paper_sections').where({ id: order[k] }).update({ position: (k + 1) * 10 });
    }
    return res.redirect(back(t, s));
  }
  if (action === 'insert') {
    const all = await acceptedFindings(t.id, null);
    const f = all.find((x) => x.id === parseInt(req.body.finding, 10));
    if (!f) { req.flash('error', 'That finding isn’t accepted yet.'); return res.redirect(back(t, s)); }
    const body = (String(s.body || '').trim() ? String(s.body).trim() + '\n\n' : '') + f.text.trim() + ' ' + f.marks;
    await db('paper_sections').where({ id: s.id }).update({ body, updated_by: req.user.id, updated_at: now() });
    req.flash('ok', 'Finding inserted with its citation. Rewrite it in your own words when you’re ready.');
    return res.redirect(back(t, s));
  }
  if (action === 'draft') {
    const items = await acceptedFindings(t.id, s.part_id ? [s.part_id] : null);
    if (!items.length) { req.flash('error', s.part_id ? 'Accept this part’s findings first, then draft from them.' : 'Accept some findings first, then draft from them.'); return res.redirect(back(t, s)); }
    let text = '', note = null;
    if (llm.available()) {
      try { text = await agent.draftSection(t, s, items); } catch (e) { note = 'The AI service couldn’t draft this right now (' + e.message + '). The findings were added as they are instead.'; }
    }
    if (!text) text = items.map((f) => f.text.trim() + ' ' + f.marks).join('\n\n');
    // keep only markers that point at real sources
    const valid = new Set(items.flatMap((f) => f.srcIds));
    text = text.replace(MARK, (m, id) => (valid.has(parseInt(id, 10)) ? m : ''));
    const body = (String(s.body || '').trim() ? String(s.body).trim() + '\n\n' : '') + text;
    await db('paper_sections').where({ id: s.id }).update({ body, updated_by: req.user.id, updated_at: now() });
    await audit(req.user.id, t.id, 'paper.drafted', 'Drafted “' + s.title + '” from ' + items.length + ' findings');
    req.flash(note ? 'error' : 'ok', note || (llm.available() ? 'Drafted from accepted findings. Edit it in your own words.' : 'Accepted findings added. Rewrite them in your own words (connect an AI service to get a written draft).'));
    return res.redirect(back(t, s));
  }
  // save
  const title = clean(req.body.title) || s.title;
  await db('paper_sections').where({ id: s.id }).update({ title, body: String(req.body.body || '').slice(0, 100000), updated_by: req.user.id, updated_at: now() });
  req.flash('ok', 'Saved.');
  res.redirect(back(t, s));
});
r.post('/topics/:tid/paper/sections/:sid/comments', auth.loadTopic('member'), writable, loadSection, async (req, res) => {
  const t = req.topic, s = req.section;
  if (req.body.action === 'resolve' || req.body.action === 'delete') {
    const c = await db('paper_comments').where({ id: parseInt(req.body.id, 10), section_id: s.id }).first();
    if (c && (c.user_id === req.user.id || req.topicRole === 'leader')) {
      if (req.body.action === 'delete') await db('paper_comments').where({ id: c.id }).del();
      else await db('paper_comments').where({ id: c.id }).update({ resolved: true });
    }
    return res.redirect(back(t, s, '#comments'));
  }
  const body = clean(req.body.body, 2000);
  if (body) {
    await db('paper_comments').insert({ section_id: s.id, user_id: req.user.id, body, created_at: now() });
    await notify(await topicLeaders(t.id), { kind: 'message', title: req.user.name + ' suggested an edit to “' + s.title + '”', body: body.slice(0, 140), link: back(t, s, '#comments') }, req.user.id);
  }
  res.redirect(back(t, s, '#comments'));
});

// ---------- Export ----------
async function buildDocx(t) {
  const D = require('docx');
  const sections = await db('paper_sections').where({ topic_id: t.id }).orderBy('position').orderBy('id');
  const { num, refs } = await numbering(sections);
  const children = [new D.Paragraph({ text: t.title, heading: D.HeadingLevel.TITLE })];
  if (t.question) children.push(new D.Paragraph({ children: [new D.TextRun({ text: 'Research question: ' + t.question, italics: true })] }));
  sections.forEach((s) => {
    const text = plain(s.body, num).trim();
    if (!text) return;
    children.push(new D.Paragraph({ text: s.title, heading: D.HeadingLevel.HEADING_1 }));
    text.split(/\n\s*\n/).forEach((p) => children.push(new D.Paragraph({ children: [new D.TextRun(p.replace(/\s*\n\s*/g, ' '))], spacing: { after: 160 } })));
  });
  if (refs.length) {
    children.push(new D.Paragraph({ text: 'References', heading: D.HeadingLevel.HEADING_1 }));
    refs.forEach((x) => children.push(new D.Paragraph({ children: [new D.TextRun('[' + x.n + '] ' + x.text)], spacing: { after: 120 } })));
  }
  const doc = new D.Document({ creator: 'CTENT', title: t.title, styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } }, sections: [{ children }] });
  return D.Packer.toBuffer(doc);
}
const fileName = (t) => (t.code + ' ' + t.title).replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 80) + '.docx';

r.get('/topics/:tid/paper.docx', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  await ensureSections(t);
  const buf = await buildDocx(t);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', 'attachment; filename="' + fileName(t) + '"');
  res.send(buf);
});
r.get('/topics/:tid/paper/print', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const sections = await ensureSections(t);
  const { num, refs } = await numbering(sections);
  res.render('pages/paper-print', { title: t.title, sections: sections.filter((s) => String(s.body || '').trim()).map((s) => ({ title: s.title, html: renderBody(s.body, num) })), refs });
});
r.post('/topics/:tid/paper/final', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  await ensureSections(t);
  const sections = await db('paper_sections').where({ topic_id: t.id });
  if (!sections.some((s) => String(s.body || '').trim())) { req.flash('error', 'Write at least one section first.'); return res.redirect('/topics/' + t.id + '/paper'); }
  const buf = await buildDocx(t);
  const fid = await db.insertId('files', { topic_id: t.id, name: fileName(t), folder: 'Final report', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: buf.length, data: buf, uploaded_by: req.user.id, created_at: now() });
  await audit(req.user.id, t.id, 'paper.exported', 'Saved the final paper as ' + fileName(t));
  req.flash('ok', 'The paper was saved as a Word file. Choose it as the final report below.');
  res.redirect('/topics/' + t.id + '/finish?file=' + fid + '#report');
});

module.exports = r;
module.exports.acceptedFindings = acceptedFindings;
