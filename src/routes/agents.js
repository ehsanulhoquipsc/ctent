'use strict';
// Plan parts & agents, the findings board, and reviewing one agent's findings.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const agent = require('../lib/agent');
const llm = require('../lib/llm');
const { SOURCE_TYPES } = require('../lib/research');
const { audit } = require('../lib/events');
const { now } = require('../lib/util');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const crumb = (t, label) => '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / ' + label;
const DEPTHS = ['quick', 'standard', 'deep'];
function writable(req, res, next) {
  if (req.topic.status === 'archived') { req.flash('error', 'This topic is archived and read-only.'); return res.redirect('/topics/' + req.topic.id); }
  next();
}
const sourcesFrom = (v) => [].concat(v || []).map(String).filter((s) => SOURCE_TYPES[s]).join(',') || 'papers';
const base = (t) => '/topics/' + t.id + '/agents';

async function partsOf(topicId) {
  const parts = await db('parts').where({ topic_id: topicId }).orderBy('position').orderBy('id');
  if (!parts.length) return [];
  const runs = await db('agent_runs').whereIn('part_id', parts.map((p) => p.id)).orderBy('id', 'desc').select('id', 'part_id', 'status', 'confidence', 'finished_at');
  const latest = {};
  runs.forEach((x) => { if (!latest[x.part_id]) latest[x.part_id] = x; });
  const ids = Object.values(latest).map((x) => x.id);
  const fc = ids.length ? await db('agent_findings').whereIn('run_id', ids).groupBy('run_id').select('run_id').count({ n: '*' }) : [];
  const sc = ids.length ? await db('agent_sources').whereIn('run_id', ids).groupBy('run_id').select('run_id').count({ n: '*' }) : [];
  const kc = ids.length ? await db('agent_findings').whereIn('run_id', ids).where({ kept: true }).groupBy('run_id').select('run_id').count({ n: '*' }) : [];
  const num = (list, id) => Number((list.find((x) => x.run_id === id) || { n: 0 }).n);
  return parts.map((p) => {
    const run = latest[p.id] || null;
    return { ...p, run, findings: run ? num(fc, run.id) : 0, sources: run ? num(sc, run.id) : 0, kept: run ? num(kc, run.id) : 0, runs: runs.filter((x) => x.part_id === p.id).length };
  });
}

// ---------- Plan parts & agents ----------
r.get('/topics/:tid/agents', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const parts = await partsOf(t.id);
  const people = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', t.id)
    .orderByRaw("case topic_members.role when 'leader' then 0 when 'member' then 1 else 2 end").select('users.id', 'users.name', 'users.color', 'users.title', 'topic_members.role');
  res.render('pages/agents', { title: 'Plan & agents · ' + t.code, active: 'topics', tab: 'Plan & agents', crumb: crumb(t, 'Plan & agents'),
    parts, people, SOURCE_TYPES, DEPTHS, aiOn: llm.available(), aiLabel: llm.label(), busy: parts.filter((p) => ['queued', 'running'].includes(p.agent_status)).length });
});
r.post('/topics/:tid/agents/question', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const since = /^\d{4}$/.test(String(req.body.since || '')) ? req.body.since : null;
  await db('topics').where({ id: t.id }).update({ question: clean(req.body.question, 2000) || null, agent_since: since });
  req.flash('ok', 'Research question saved.');
  res.redirect(base(t));
});
r.post('/topics/:tid/agents/suggest', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const q = (await db('topics').where({ id: t.id }).first()).question;
  if (!q) { req.flash('error', 'Write the research question first.'); return res.redirect(base(t)); }
  if (!llm.available()) { req.flash('error', 'Suggesting parts needs an AI service. Add parts yourself for now, or ask your admin to connect one (GEMINI_API_KEY).'); return res.redirect(base(t)); }
  try {
    const list = await agent.suggestParts(q, t.title);
    const max = Number((await db('parts').where({ topic_id: t.id }).max({ m: 'position' }).first()).m) || 0;
    for (let i = 0; i < list.length; i++) {
      await db('parts').insert({ topic_id: t.id, title: list[i].title, description: list[i].brief, agent_name: list[i].agent || 'Research agent', agent_sources: 'papers,wiki', agent_depth: 'standard', agent_status: 'draft', position: max + i + 1, status: 'open', created_at: now() });
    }
    await audit(req.user.id, t.id, 'agent.suggested', 'Added ' + list.length + ' suggested parts');
    req.flash('ok', list.length + ' parts suggested. Edit or delete any of them, then launch.');
  } catch (e) { req.flash('error', 'The AI service couldn’t suggest parts right now: ' + e.message); }
  res.redirect(base(t));
});
r.post('/topics/:tid/agents/parts', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const title = clean(req.body.title);
  if (title.length < 3) { req.flash('error', 'Give the part a title.'); return res.redirect(base(t)); }
  const max = Number((await db('parts').where({ topic_id: t.id }).max({ m: 'position' }).first()).m) || 0;
  await db('parts').insert({ topic_id: t.id, title, description: clean(req.body.brief, 1500), agent_name: clean(req.body.agent_name, 100) || 'Research agent',
    agent_sources: sourcesFrom(req.body.sources), agent_depth: DEPTHS.includes(req.body.depth) ? req.body.depth : 'standard', agent_status: 'draft', position: max + 1, status: 'open', created_at: now() });
  await audit(req.user.id, t.id, 'part.created', 'Added part “' + title + '”');
  req.flash('ok', 'Part added. Launch its agent when the brief is ready.');
  res.redirect(base(t));
});
r.post('/topics/:tid/agents/launch-all', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const parts = await db('parts').where({ topic_id: t.id }).whereIn('agent_status', ['draft', 'failed']);
  for (const p of parts) await agent.launch(t, p, req.user.id);
  if (parts.length) await audit(req.user.id, t.id, 'agent.launched', 'Launched ' + parts.length + ' agents');
  req.flash(parts.length ? 'ok' : 'error', parts.length ? parts.length + ' agents launched. Findings arrive as each one finishes.' : 'There are no agents waiting to launch.');
  res.redirect('/topics/' + t.id + '/findings');
});
r.get('/topics/:tid/agents/status.json', auth.loadTopic('member'), async (req, res) => {
  await agent.watchdog();
  const parts = await db('parts').where({ topic_id: req.topic.id }).select('id', 'agent_status', 'agent_progress', 'agent_step');
  res.json({ parts: parts.map((p) => ({ id: p.id, status: p.agent_status, progress: p.agent_progress, step: p.agent_step })) });
});

async function loadPart(req, res, next) {
  const part = await db('parts').where({ id: parseInt(req.params.pid, 10), topic_id: req.topic.id }).first();
  if (!part) return auth.notFound(res, 'That part doesn’t exist or was deleted.');
  req.part = part;
  next();
}
r.post('/topics/:tid/agents/:pid', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  if (req.body.action === 'delete') {
    await db('parts').where({ id: p.id }).del();
    await audit(req.user.id, t.id, 'part.deleted', 'Deleted part “' + p.title + '” and its agent');
    req.flash('ok', 'Part deleted.');
    return res.redirect(base(t));
  }
  const title = clean(req.body.title);
  if (title.length < 3) { req.flash('error', 'Give the part a title.'); return res.redirect(base(t)); }
  await db('parts').where({ id: p.id }).update({ title, description: clean(req.body.brief, 1500), agent_name: clean(req.body.agent_name, 100) || 'Research agent',
    agent_sources: sourcesFrom(req.body.sources), agent_depth: DEPTHS.includes(req.body.depth) ? req.body.depth : p.agent_depth || 'standard' });
  req.flash('ok', 'Agent updated.' + (['review', 'accepted'].includes(p.agent_status) ? ' Run it again to use the new brief.' : ''));
  res.redirect(base(t) + '#part' + p.id);
});
r.post('/topics/:tid/agents/:pid/launch', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  if (['queued', 'running'].includes(p.agent_status)) { req.flash('error', 'This agent is already working.'); return res.redirect(base(t)); }
  await agent.launch(t, p, req.user.id);
  await audit(req.user.id, t.id, 'agent.launched', 'Launched ' + (p.agent_name || 'agent') + ' for “' + p.title + '”');
  req.flash('ok', (p.agent_name || 'Agent') + ' launched.');
  res.redirect(req.body.back === 'review' ? base(t) + '/' + p.id : '/topics/' + t.id + '/findings');
});

r.post('/topics/:tid/agents/:pid/stop', auth.loadTopic('leader'), loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  await agent.stop(p, req.user.name);
  await audit(req.user.id, t.id, 'agent.stopped', 'Stopped ' + (p.agent_name || 'the agent') + ' on “' + p.title + '”');
  req.flash('ok', 'Agent stopped. Earlier findings are kept.');
  res.redirect(req.body.back === 'review' ? base(t) + '/' + p.id : base(t));
});

// ---------- Findings board ----------
r.get('/topics/:tid/findings', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  await agent.watchdog();
  const parts = await partsOf(t.id);
  const runIds = parts.filter((p) => p.run).map((p) => p.run.id);
  const log = runIds.length ? await db('agent_logs').join('agent_runs', 'agent_runs.id', 'agent_logs.run_id').join('parts', 'parts.id', 'agent_runs.part_id')
    .where('agent_runs.topic_id', t.id).orderBy('agent_logs.id', 'desc').limit(12).select('agent_logs.*', 'parts.agent_name', 'parts.title as part_title') : [];
  res.render('pages/findings', { title: 'Findings · ' + t.code, active: 'topics', tab: 'Findings', crumb: crumb(t, 'Findings'), parts, log, show: ['review', 'running'].includes(req.query.show) ? req.query.show : 'all' });
});

// ---------- Review one agent ----------
r.get('/topics/:tid/agents/:pid', auth.loadTopic('member'), loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const runs = await db('agent_runs').where({ part_id: p.id }).orderBy('id', 'desc');
  const run = runs.find((x) => x.id === parseInt(req.query.run, 10)) || runs[0] || null;
  const [findings, sources, logs, comments] = run ? await Promise.all([
    db('agent_findings').where({ run_id: run.id }).orderBy('position'),
    db('agent_sources').where({ run_id: run.id }).orderBy('n'),
    db('agent_logs').where({ run_id: run.id }).orderBy('id'),
    db('agent_comments').leftJoin('users', 'users.id', 'agent_comments.user_id').where('agent_comments.part_id', p.id).orderBy('agent_comments.id').select('agent_comments.*', 'users.name', 'users.color', 'users.id as uid')
  ]) : [[], [], [], await db('agent_comments').leftJoin('users', 'users.id', 'agent_comments.user_id').where('agent_comments.part_id', p.id).orderBy('agent_comments.id').select('agent_comments.*', 'users.name', 'users.color', 'users.id as uid')];
  const parts = await db('parts').where({ topic_id: t.id }).orderBy('position').orderBy('id').select('id', 'title');
  const idx = parts.findIndex((x) => x.id === p.id);
  res.render('pages/agent', { title: p.title + ' · ' + t.code, active: 'topics', tab: 'Findings', crumb: crumb(t, '<a href="/topics/' + t.id + '/findings">Findings</a> / Part ' + String(idx + 1).padStart(2, '0')),
    part: p, run, runs, findings, sources, logs, comments, n: idx + 1, prev: parts[idx - 1] || null, next: parts[idx + 1] || null, aiOn: llm.available() });
});
r.post('/topics/:tid/agents/:pid/findings', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const run = await db('agent_runs').where({ part_id: p.id, status: 'done' }).orderBy('id', 'desc').first();
  if (!run) { req.flash('error', 'There are no findings to review yet.'); return res.redirect(base(t) + '/' + p.id); }
  if (req.body.action === 'reopen') {
    await db('parts').where({ id: p.id }).update({ agent_status: 'review' });
    req.flash('ok', 'Back in review. Change what you keep, then accept again.');
    return res.redirect(base(t) + '/' + p.id);
  }
  const keep = new Set([].concat(req.body.keep || []).map((x) => parseInt(x, 10)));
  const all = await db('agent_findings').where({ run_id: run.id }).select('id');
  for (const f of all) await db('agent_findings').where({ id: f.id }).update({ kept: keep.has(f.id) });
  if (req.body.action === 'accept') {
    if (!keep.size) { req.flash('error', 'Keep at least one finding to accept, or run the agent again.'); return res.redirect(base(t) + '/' + p.id); }
    await db('parts').where({ id: p.id }).update({ agent_status: 'accepted' });
    await audit(req.user.id, t.id, 'agent.accepted', 'Accepted ' + keep.size + ' of ' + all.length + ' findings for “' + p.title + '”');
    req.flash('ok', keep.size + ' findings accepted. They’re ready to use in the final paper.');
  } else req.flash('ok', 'Saved which findings to keep.');
  res.redirect(base(t) + '/' + p.id);
});
r.post('/topics/:tid/agents/:pid/ask', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const q = clean(req.body.followup, 1000);
  if (!q) { req.flash('error', 'Write what the agent should look into.'); return res.redirect(base(t) + '/' + p.id); }
  if (['queued', 'running'].includes(p.agent_status)) { req.flash('error', 'This agent is already working. Try again when it finishes.'); return res.redirect(base(t) + '/' + p.id); }
  await agent.launch(t, p, req.user.id, q);
  await audit(req.user.id, t.id, 'agent.followup', 'Asked ' + (p.agent_name || 'the agent') + ' to dig deeper on “' + p.title + '”');
  req.flash('ok', 'Sent. The agent is looking into it — the earlier findings stay in its history.');
  res.redirect(base(t) + '/' + p.id);
});
r.post('/topics/:tid/agents/:pid/comments', auth.loadTopic('member'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  if (req.body.action === 'delete') {
    const c = await db('agent_comments').where({ id: parseInt(req.body.id, 10), part_id: p.id }).first();
    if (c && (c.user_id === req.user.id || req.topicRole === 'leader')) await db('agent_comments').where({ id: c.id }).del();
    return res.redirect(base(t) + '/' + p.id + '#comments');
  }
  const body = clean(req.body.body, 2000);
  if (body) {
    await db('agent_comments').insert({ part_id: p.id, user_id: req.user.id, body, created_at: now() });
    const { notify, topicLeaders } = require('../lib/events');
    await notify(await topicLeaders(t.id), { kind: 'message', title: req.user.name + ' commented on “' + p.title + '” findings', body: body.slice(0, 140), link: base(t) + '/' + p.id + '#comments' }, req.user.id);
  }
  res.redirect(base(t) + '/' + p.id + '#comments');
});

module.exports = r;
