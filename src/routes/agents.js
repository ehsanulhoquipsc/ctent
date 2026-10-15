'use strict';
// Plan parts & agents, the findings board, and reviewing one agent's findings.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const agent = require('../lib/agent');
const llm = require('../lib/llm');
const research = require('../lib/research');
const { SOURCE_TYPES, GROUPS } = research;
const evidence = require('../lib/evidence');
const exporter = require('../lib/evidence-export');
const { audit } = require('../lib/events');
const { now } = require('../lib/util');
const plain = require('../lib/plain');
const partsLib = require('../lib/parts');
const { partState } = require('../lib/journey');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const crumb = (t, label) => '<a href="/topics">Projects</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / ' + label;
const DEPTHS = ['quick', 'standard', 'deep'];
function writable(req, res, next) {
  if (req.topic.status === 'archived') { req.flash('error', 'This topic is archived and read-only.'); return res.redirect('/topics/' + req.topic.id); }
  next();
}
const sourcesFrom = (v) => research.normalizeKeys([].concat(v || []).map(String).join(',')).join(',') || research.DEFAULT_SOURCES;
const optionsFrom = (v) => [].concat(v || []).map(String).filter((o) => agent.OPTIONS[o]).join(',');
const langFrom = (v) => (v === 'bn' ? 'bn' : 'en');
// Settings shared by the add and edit forms.
const agentSettings = (b, p) => ({ agent_sources: sourcesFrom(b.sources), agent_depth: DEPTHS.includes(b.depth) ? b.depth : (p && p.agent_depth) || 'standard', agent_lang: langFrom(b.lang), agent_options: b.opts_present ? optionsFrom(b.opts) : (p ? p.agent_options : null) });
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
  const tasks = await db('tasks').leftJoin('users', 'users.id', 'tasks.assignee_id').whereIn('tasks.part_id', parts.map((p) => p.id)).orderBy('tasks.id', 'desc')
    .select('tasks.id', 'tasks.part_id', 'tasks.status', 'tasks.due_date', 'tasks.assignee_id', 'users.name as who', 'users.color as who_color');
  const owners = await db('users').whereIn('id', parts.map((p) => p.proposed_user_id).filter(Boolean)).select('id', 'name', 'color');
  const ctx = await plain.queueContext(parts);
  return parts.map((p) => {
    const run = latest[p.id] || null;
    const task = tasks.find((x) => x.part_id === p.id) || null;
    const state = partState(p, task);
    const owner = owners.find((o) => o.id === p.proposed_user_id) || null;
    const due = (task && task.due_date) || p.due_date;
    let plainText = plain.plainStatus(p, ctx);
    if (p.handler === 'person') {
      const d = due ? ' · due ' + require('../lib/util').fmtDate(due) : '';
      plainText = !task ? 'Needs a person' : ({ todo: 'Not started' + d, doing: 'In progress' + d, changes: 'Changes asked' + d, review: 'Handed in — waiting for your review', done: 'Approved' })[task.status] || 'In progress' + d;
    }
    return { ...p, run, task, state, owner, due, plain: plainText, left: plain.minutesLeft(p), findings: run ? num(fc, run.id) : 0, sources: run ? num(sc, run.id) : 0, kept: run ? num(kc, run.id) : 0, runs: runs.filter((x) => x.part_id === p.id).length };
  });
}

// Members who can take a part, with their expertise and open tasks.
async function teamOf(topicId) {
  const m = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', topicId).whereNot('topic_members.role', 'guest').where('users.status', 'active')
    .orderBy('users.name').select('users.id', 'users.name', 'users.color', 'users.title');
  const ids = m.map((x) => x.id);
  const exp = ids.length ? await db('expertise').whereIn('user_id', ids).orderBy('level', 'desc') : [];
  const load = ids.length ? await db('tasks').whereIn('assignee_id', ids).whereNot('status', 'done').groupBy('assignee_id').select('assignee_id').count({ n: '*' }) : [];
  return m.map((x) => ({ ...x, skills: exp.filter((e) => e.user_id === x.id).map((e) => e.name), load: Number((load.find((l) => l.assignee_id === x.id) || { n: 0 }).n) }));
}

// ---------- Plan parts & agents ----------
async function researchPage(req, res) {
  const t = req.topic;
  const parts = await partsOf(t.id);
  res.render('pages/agents', { title: 'Research · ' + t.code, active: 'topics', tab: 'Plan & agents', crumb: crumb(t, 'Research'),
    parts, SOURCE_TYPES, GROUPS, DEPTHS, DEPTH: agent.DEPTH, OPTIONS: agent.OPTIONS, DEFAULT_SOURCES: research.DEFAULT_SOURCES, available: research.available, normalizeKeys: research.normalizeKeys, label: research.label,
    templates: require('./topics').TEMPLATES, aiOn: llm.available(), aiLabel: llm.label(), busy: parts.filter((p) => p.handler !== 'person' && ['queued', 'running'].includes(p.agent_status)).length,
    members: await teamOf(t.id), tipsKey: parts.length ? 'research' : '' });
}
r.get('/topics/:tid/agents', auth.loadTopic('member'), researchPage);
// Add a template's parts (when starting from scratch on the Research page).
r.post('/topics/:tid/agents/template', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const tpl = require('./topics').TEMPLATES[req.body.template];
  if (!tpl || !tpl.parts.length) { req.flash('error', 'Choose a template.'); return res.redirect(base(t)); }
  const max = Number((await db('parts').where({ topic_id: t.id }).max({ m: 'position' }).first()).m) || 0;
  let pos = max;
  for (const [title, brief] of tpl.parts) await db('parts').insert({ topic_id: t.id, title, description: brief, agent_name: title.split(/ [&,]/)[0] + ' agent', agent_sources: research.DEFAULT_SOURCES, agent_depth: 'standard', agent_status: 'draft', handler: t.mode === 'manual' ? 'person' : 'agent', position: ++pos, status: 'open', created_at: now() });
  await audit(req.user.id, t.id, 'agent.template', 'Added ' + tpl.parts.length + ' parts from the “' + tpl.name + '” template');
  req.flash('ok', tpl.parts.length + ' parts added. Edit any brief, then launch the agents.');
  res.redirect(base(t) + '#parts');
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
      await db('parts').insert({ topic_id: t.id, title: list[i].title, description: list[i].brief, agent_name: list[i].agent || 'Research agent', agent_sources: research.DEFAULT_SOURCES, agent_depth: 'standard', agent_status: 'draft', handler: t.mode === 'manual' ? 'person' : 'agent', position: max + i + 1, status: 'open', created_at: now() });
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
  const who = req.body.who !== undefined ? String(req.body.who) : (t.mode === 'manual' ? '' : 'agent');
  const pid = await db.insertId('parts', { topic_id: t.id, title, description: clean(req.body.brief, 1500), agent_name: clean(req.body.agent_name, 100) || title.split(/ [&,—-]/)[0].trim() + ' agent',
    ...agentSettings(req.body, null), agent_status: 'draft', handler: who === 'agent' ? 'agent' : 'person', position: max + 1, status: 'open', created_at: now() });
  if (parseInt(who, 10)) await partsLib.assignToPerson(t, await db('parts').where({ id: pid }).first(), parseInt(who, 10), req.body.due, req.user);
  await audit(req.user.id, t.id, 'part.created', 'Added part “' + title + '”');
  req.flash('ok', 'Part added. Launch its agent when the brief is ready.');
  res.redirect(base(t));
});
r.post('/topics/:tid/agents/launch-all', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const parts = await db('parts').where({ topic_id: t.id, handler: 'agent' }).whereIn('agent_status', ['draft', 'failed']);
  for (const p of parts) await agent.launch(t, p, req.user.id);
  if (parts.length) await audit(req.user.id, t.id, 'agent.launched', 'Launched ' + parts.length + ' agents');
  req.flash(parts.length ? 'ok' : 'error', parts.length ? parts.length + ' agents launched. Findings arrive as each one finishes.' : 'There are no agents waiting to launch.');
  res.redirect(base(t) + '#parts');
});
r.get('/topics/:tid/agents/status.json', auth.loadTopic('member'), async (req, res) => {
  await agent.watchdog();
  const parts = await db('parts').where({ topic_id: req.topic.id }).orderBy('position').orderBy('id').select('id', 'title', 'agent_name', 'agent_depth', 'agent_status', 'agent_progress', 'agent_step', 'handler');
  const ctx = await plain.queueContext(parts);
  const T = (x) => require('../lib/i18n').t(x, res.locals.lang || 'en');
  const counts = {};
  for (const p of parts.filter((x) => x.handler !== 'person')) {
    const run = ['review', 'accepted'].includes(p.agent_status) ? await db('agent_runs').where({ part_id: p.id, status: 'done' }).orderBy('id', 'desc').first('id') : null;
    counts[p.id] = run ? Number((await db('agent_sources').where({ run_id: run.id }).count({ n: '*' }).first()).n) : 0;
  }
  res.json({ parts: parts.filter((p) => p.handler !== 'person').map((p) => ({ id: p.id, title: p.title, name: p.agent_name || 'Research agent', status: p.agent_status, progress: p.agent_progress, step: p.agent_step,
    plain: T(plain.plainStatus(p, ctx)), left: plain.minutesLeft(p), leftText: plain.minutesLeft(p) ? T('About ' + plain.minutesLeft(p) + ' min left') : '', cards: counts[p.id], href: base(req.topic) + '/' + p.id,
    doneMsg: T((p.agent_name || 'Research agent') + ' found ' + counts[p.id] + ' sources'), failMsg: T((p.agent_name || 'The agent') + ' stopped. Run it again.') })) });
});

async function loadPart(req, res, next) {
  const part = await db('parts').where({ id: parseInt(req.params.pid, 10), topic_id: req.topic.id }).first();
  if (!part) return auth.notFound(res, 'That part doesn’t exist or was deleted.');
  req.part = part;
  next();
}

// Who does a part: an AI agent or a person (with a due date).
r.post('/topics/:tid/agents/:pid/assign', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const who = String(req.body.who || '');
  if (who === 'agent') {
    if (p.handler !== 'agent') { await partsLib.assignToAgent(p, req.user); await audit(req.user.id, t.id, 'part.assigned', '“' + p.title + '” given to an AI agent'); }
    req.flash('ok', 'An AI agent now handles “' + p.title + '”. Launch it when you’re ready.');
  } else if (parseInt(who, 10)) {
    if (['queued', 'running'].includes(p.agent_status)) await agent.stop(p, req.user.name);
    const ok = await partsLib.assignToPerson(t, p, parseInt(who, 10), req.body.due, req.user);
    if (!ok) { req.flash('error', 'Choose a member of this project.'); return res.redirect(base(t) + '#part' + p.id); }
    const person = await db('users').where({ id: parseInt(who, 10) }).first();
    await audit(req.user.id, t.id, 'part.assigned', '“' + p.title + '” given to ' + person.name);
    req.flash('ok', '“' + p.title + '” given to ' + person.name + '. They’ve been notified.');
  } else {
    await db('parts').where({ id: p.id }).update({ handler: 'person', proposed_user_id: null });
    req.flash('ok', 'Choose who takes “' + p.title + '”.');
  }
  res.redirect(base(t) + '#part' + p.id);
});

// Switch mode mid-project: finished parts stay, unfinished parts get a person or an agent. Nothing is deleted.
r.get('/topics/:tid/mode', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const parts = await partsOf(t.id);
  res.render('pages/mode-switch', { title: 'Switch mode · ' + t.code, active: 'topics', tab: 'Plan & agents', crumb: crumb(t, 'Switch mode'), parts, members: await teamOf(t.id), target: t.mode === 'manual' ? 'agent' : 'manual' });
});
r.post('/topics/:tid/mode', auth.loadTopic('leader'), writable, async (req, res) => {
  const t = req.topic;
  const target = req.body.mode === 'agent' ? 'agent' : 'manual';
  const parts = await partsOf(t.id);
  let toPeople = 0, toAgents = 0;
  const launch = [];
  for (const p of parts) {
    if (p.state === 'accepted' || p.state === 'review') continue; // finished or waiting for review: kept as is
    const who = String(req.body['who_' + p.id] || 'keep');
    if (who === 'keep') continue;
    if (who === 'agent' && p.handler !== 'agent') { await partsLib.assignToAgent(p, req.user); toAgents++; launch.push(p.id); }
    else if (parseInt(who, 10) && !(p.handler === 'person' && p.proposed_user_id === parseInt(who, 10))) {
      if (['queued', 'running'].includes(p.agent_status)) await agent.stop(p, req.user.name);
      if (await partsLib.assignToPerson(t, p, parseInt(who, 10), req.body['due_' + p.id], req.user)) toPeople++;
    }
  }
  await db('topics').where({ id: t.id }).update({ mode: target });
  let launched = 0;
  if (req.body.launch && llm) {
    const fresh = await db('topics').where({ id: t.id }).first();
    for (const id of launch) { const p = await db('parts').where({ id }).first(); if (p && ['draft', 'failed'].includes(p.agent_status)) { await agent.launch(fresh, p, req.user.id); launched++; } }
  }
  await audit(req.user.id, t.id, 'topic.mode', 'Switched to ' + (target === 'manual' ? 'Manual' : 'Agent') + ' mode' + (toPeople ? ' · ' + toPeople + ' parts to people' : '') + (toAgents ? ' · ' + toAgents + ' parts to agents' : ''));
  req.flash('ok', 'Switched to ' + (target === 'manual' ? 'Manual' : 'Agent') + ' mode.' + (toPeople ? ' ' + toPeople + ' member' + (toPeople === 1 ? '' : 's') + ' notified.' : '') + (launched ? ' ' + launched + ' agent' + (launched === 1 ? '' : 's') + ' launching.' : toAgents ? ' ' + toAgents + ' part' + (toAgents === 1 ? '' : 's') + ' now with agents — launch them when ready.' : '') + ' Nothing was deleted.');
  res.redirect(base(t));
});
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
    ...agentSettings(req.body, p) });
  req.flash('ok', 'Agent updated.' + (['review', 'accepted'].includes(p.agent_status) ? ' Run it again to use the new brief.' : ''));
  res.redirect(base(t) + '#part' + p.id);
});
r.post('/topics/:tid/agents/:pid/launch', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  if (['queued', 'running'].includes(p.agent_status)) { req.flash('error', 'This agent is already working.'); return res.redirect(base(t)); }
  await agent.launch(t, p, req.user.id);
  await audit(req.user.id, t.id, 'agent.launched', 'Launched ' + (p.agent_name || 'agent') + ' for “' + p.title + '”');
  req.flash('ok', (p.agent_name || 'Agent') + ' launched.');
  res.redirect(req.body.back === 'review' ? base(t) + '/' + p.id : base(t) + '#part' + p.id);
});

r.post('/topics/:tid/agents/:pid/stop', auth.loadTopic('leader'), loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  await agent.stop(p, req.user.name);
  await audit(req.user.id, t.id, 'agent.stopped', 'Stopped ' + (p.agent_name || 'the agent') + ' on “' + p.title + '”');
  req.flash('ok', 'Agent stopped. Earlier findings are kept.');
  res.redirect(req.body.back === 'review' ? base(t) + '/' + p.id : base(t));
});

// ---------- Findings board ----------
// The old findings board is now part of the Research page.
r.get('/topics/:tid/findings', auth.loadTopic('member'), async (req, res, next) => { await agent.watchdog(); next(); }, researchPage);

// ---------- Review one agent: evidence cards, agreement map, research gaps, overview ----------
const obj = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } };
async function latestDone(partId) { return db('agent_runs').where({ part_id: partId, status: 'done' }).orderBy('id', 'desc').first(); }
async function cardsOf(runId) { return (await db('agent_sources').where({ run_id: runId }).orderBy('n')).map(agent.parseCard); }

r.get('/topics/:tid/agents/:pid', auth.loadTopic('member'), loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const runs = await db('agent_runs').where({ part_id: p.id }).orderBy('id', 'desc');
  const run = runs.find((x) => x.id === parseInt(req.query.run, 10)) || runs.find((x) => x.status === 'done') || runs[0] || null;
  const commentsQ = db('agent_comments').leftJoin('users', 'users.id', 'agent_comments.user_id').where('agent_comments.part_id', p.id).orderBy('agent_comments.id').select('agent_comments.*', 'users.name', 'users.color', 'users.id as uid');
  const [cards, logs, comments] = run ? await Promise.all([cardsOf(run.id), db('agent_logs').where({ run_id: run.id }).orderBy('id'), commentsQ]) : [[], [], await commentsQ];
  const working = runs[0] && runs[0].status === 'running';
  const liveLogs = working && run && run.id !== runs[0].id ? await db('agent_logs').where({ run_id: runs[0].id }).orderBy('id') : logs;
  const parts = await db('parts').where({ topic_id: t.id }).orderBy('position').orderBy('id').select('id', 'title');
  const idx = parts.findIndex((x) => x.id === p.id);
  const synthesis = run ? obj(run.synthesis, []) : [];
  const gapData = run ? obj(run.gap_data, null) : null;
  const plan = run ? obj(run.plan, {}) : {};
  const lang = (run && run.lang) || p.agent_lang || 'en';
  // Overview numbers, counted here so the charts are plain HTML and CSS.
  const C = evidence.count;
  const overview = {
    years: C(cards.map((c) => c.year).filter(Boolean).map(String)).sort((a, b) => a[0] - b[0]),
    tiers: ['high', 'medium', 'low'].map((k) => [k, cards.filter((c) => c.tier === k).length]),
    venues: C(cards.filter((c) => c.type === 'paper').map((c) => c.venue)).slice(0, 8),
    sources: C(cards.flatMap((c) => (c.found_in.length ? c.found_in : [c.source]))).slice(0, 10).map(([k, n]) => [research.label(k), n]),
    types: C(cards.map((c) => c.type))
  };
  res.render('pages/agent', { title: p.title + ' · ' + t.code, active: 'topics', tab: 'Plan & agents', crumb: crumb(t, '<a href="/topics/' + t.id + '/agents">Research</a> / Part ' + String(idx + 1).padStart(2, '0')),
    part: p, run, runs, cards, logs, liveLogs, comments, n: idx + 1, total: parts.length, plain: plain.plainStatus(p, await plain.queueContext([p])),
    sectionId: ((await db('paper_sections').where({ topic_id: t.id, part_id: p.id }).first('id')) || {}).id || null, prev: parts[idx - 1] || null, next: parts[idx + 1] || null, aiOn: llm.available(), synthesis, gapData, plan, lang, overview,
    ev: evidence, label: research.label, questions: [...new Set((plan.questions || []).map((q) => q.question).concat(cards.map((c) => c.question).filter(Boolean)))] });
});

// Select or unselect cards (selected cards are the ones that go into the paper).
r.post('/topics/:tid/agents/:pid/select', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const p = req.part;
  const run = await latestDone(p.id);
  const json = (req.get('accept') || '').includes('json');
  if (!run) return json ? res.status(400).json({ ok: false }) : res.redirect(base(req.topic) + '/' + p.id);
  const ids = [].concat(req.body.ids || req.body.card || []).map((x) => parseInt(x, 10)).filter(Boolean);
  const on = req.body.selected === true || req.body.selected === 'true' || req.body.selected === '1';
  const valid = (await db('agent_sources').where({ run_id: run.id }).whereIn('id', ids.length ? ids : [0]).select('id')).map((x) => x.id);
  if (valid.length) {
    await db('agent_sources').whereIn('id', valid).update({ selected: on });
    await db('agent_findings').whereIn('source_id', valid).update({ kept: on });
  }
  const n = Number((await db('agent_sources').where({ run_id: run.id, selected: true }).count({ n: '*' }).first()).n);
  if (json) return res.json({ ok: true, selected: n });
  res.redirect(base(req.topic) + '/' + p.id);
});

r.post('/topics/:tid/agents/:pid/findings', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const run = await latestDone(p.id);
  if (!run) { req.flash('error', 'There are no findings to review yet.'); return res.redirect(base(t) + '/' + p.id); }
  if (req.body.action === 'reopen') {
    await db('parts').where({ id: p.id }).update({ agent_status: 'review' });
    req.flash('ok', 'Back in review. Change which cards you use, then accept again.');
    return res.redirect(base(t) + '/' + p.id);
  }
  if (req.body.card !== undefined || req.body.cards_present) { // the evidence-card form: card ids
    const pick = new Set([].concat(req.body.card || []).map((x) => parseInt(x, 10)));
    const all = await db('agent_sources').where({ run_id: run.id }).select('id');
    for (const c of all) { await db('agent_sources').where({ id: c.id }).update({ selected: pick.has(c.id) }); await db('agent_findings').where({ source_id: c.id }).update({ kept: pick.has(c.id) }); }
  } else if (req.body.keep !== undefined || req.body.action === 'save') { // older finding-level form
    const keep = new Set([].concat(req.body.keep || []).map((x) => parseInt(x, 10)));
    const all = await db('agent_findings').where({ run_id: run.id }).select('id', 'source_id');
    for (const f of all) { await db('agent_findings').where({ id: f.id }).update({ kept: keep.has(f.id) }); if (f.source_id) await db('agent_sources').where({ id: f.source_id }).update({ selected: keep.has(f.id) }); }
  }
  const kept = Number((await db('agent_findings').where({ run_id: run.id, kept: true }).count({ n: '*' }).first()).n);
  const total = Number((await db('agent_findings').where({ run_id: run.id }).count({ n: '*' }).first()).n);
  if (req.body.action === 'accept') {
    if (!kept) { req.flash('error', 'Select at least one evidence card to accept, or run the agent again.'); return res.redirect(base(t) + '/' + p.id); }
    await db('parts').where({ id: p.id }).update({ agent_status: 'accepted' });
    await audit(req.user.id, t.id, 'agent.accepted', 'Accepted ' + kept + ' of ' + total + ' evidence cards for “' + p.title + '”');
    req.flash('ok', kept + ' evidence cards accepted. They’re ready to use in the final paper.');
  } else req.flash('ok', 'Saved your selection.');
  res.redirect(base(t) + '/' + p.id);
});

// Re-run the research gaps finder on all cards or only the selected ones.
r.post('/topics/:tid/agents/:pid/gaps', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const run = await latestDone(p.id);
  if (!run) { req.flash('error', 'There are no evidence cards yet.'); return res.redirect(base(t) + '/' + p.id); }
  try {
    const out = await agent.rerunGaps(run, p, t, req.body.scope === 'selected');
    req.flash('ok', out.gaps.length + ' research gaps found from ' + (req.body.scope === 'selected' ? 'your selected cards' : 'all cards') + (out.ai ? '.' : ' (counts only — connect an AI service for deeper gaps).'));
  } catch (e) { req.flash('error', e.message); }
  res.redirect(base(t) + '/' + p.id + '#gaps');
});

// Write this part's paper section from the selected cards (AI draft with citations, or the findings as they are).
r.post('/topics/:tid/agents/:pid/draft', auth.loadTopic('leader'), writable, loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const run = await latestDone(p.id);
  const n = run ? Number((await db('agent_sources').where({ run_id: run.id, selected: true }).count({ n: '*' }).first()).n) : 0;
  if (!n) { req.flash('error', 'Select some evidence cards first.'); return res.redirect(base(t) + '/' + p.id); }
  if (p.agent_status !== 'accepted') await db('parts').where({ id: p.id }).update({ agent_status: 'accepted' });
  let sec = await db('paper_sections').where({ topic_id: t.id, part_id: p.id }).first();
  if (!sec) {
    await require('./paper').ensureSections(t);
    sec = await db('paper_sections').where({ topic_id: t.id, part_id: p.id }).first();
  }
  // The paper's own draft action, so citations and checks are the same everywhere.
  return require('./paper').draftInto(req, res, sec);
});

// Exports: evidence pack (.docx/.md), research gaps brief (.docx/.md), literature matrix (.xlsx).
r.get('/topics/:tid/agents/:pid/export/:file', auth.loadTopic('member'), loadPart, async (req, res) => {
  const t = req.topic, p = req.part;
  const m = String(req.params.file).match(/^(evidence|gaps|matrix)\.(docx|md|xlsx)$/);
  const run = await latestDone(p.id);
  if (!m || !run) return auth.notFound(res, 'Nothing to export yet.');
  const [, kind, fmt] = m;
  const lang = run.lang || 'en';
  const all = await cardsOf(run.id);
  const picked = all.filter((c) => c.selected);
  const items = picked.length ? picked : all;
  const title = p.title;
  const name = (t.code + ' ' + p.title).replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 60) + '_' + kind;
  const gapData = obj(run.gap_data, null);
  if (kind === 'matrix') {
    if (fmt !== 'xlsx') return auth.notFound(res, 'Nothing to export.');
    const buf = await exporter.matrixXlsx(title, lang, items, obj(run.synthesis, []), gapData);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(name + '.xlsx');
    return res.send(buf);
  }
  if (fmt === 'xlsx') return auth.notFound(res, 'Nothing to export.');
  let md;
  if (kind === 'gaps') {
    if (!gapData || !(gapData.gaps || []).length) return auth.notFound(res, 'No research gaps yet.');
    md = exporter.gapsMarkdown(title, lang, gapData, all);
  } else md = exporter.evidenceMarkdown(title, lang, items, (obj(run.plan, {}).questions || []).map((q) => q.question), gapData);
  if (fmt === 'md') { res.set('Content-Type', 'text/markdown; charset=utf-8').attachment(name + '.md'); return res.send(md); }
  const buf = await exporter.mdToDocx(md);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').attachment(name + '.docx');
  res.send(buf);
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
