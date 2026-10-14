'use strict';
// A research agent for one part of a topic:
//   1. plans a few searches from the part's brief
//   2. searches free sources (OpenAlex papers, Wikipedia)
//   3. keeps the most relevant sources and numbers them
//   4. asks the AI service for a summary and findings that cite ONLY those numbered sources
// Without an AI service it still collects real sources and lists their key sentences, marked low confidence.
const db = require('../db');
const llm = require('./llm');
const research = require('./research');
const { notify, audit, topicLeaders } = require('./events');
const { now } = require('./util');

const DEPTH = {
  quick: { queries: 2, perQuery: 6, keep: 8, findings: '3 to 5' },
  standard: { queries: 3, perQuery: 8, keep: 14, findings: '4 to 7' },
  deep: { queries: 5, perQuery: 10, keep: 22, findings: '6 to 10' }
};
const CONCURRENCY = Math.max(1, parseInt(process.env.AGENT_CONCURRENCY || '2', 10));
const STOP = new Set('a an and are as at be by can could do does for from has have how in into is it its of on or over should that the their this to under was what when where which who why will with within would next years year'.split(' '));

const queue = [];
let active = 0;
let testHook = null; // tests can await finished runs

async function log(runId, text) { await db('agent_logs').insert({ run_id: runId, text: String(text).slice(0, 500), created_at: now() }); }
async function step(part, progress, text) { await db('parts').where({ id: part.id }).update({ agent_progress: progress, agent_step: String(text).slice(0, 240) }); }

function keywords(text, max) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, max || 8).join(' ');
}
function firstSentences(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g) || [String(text || '').slice(0, 240)];
  return s.slice(0, n || 1).join(' ').trim();
}

async function planQueries(topic, part, followup, depth, runId) {
  const base = [part.title, keywords(part.description || part.title, 8)];
  if (followup) base.unshift(keywords(followup, 8));
  if (!llm.available()) return [...new Set(base.filter(Boolean))].slice(0, depth.queries);
  try {
    const out = await llm.json(
      'You plan literature searches for a research assistant. Reply with JSON only: {"queries": ["..."]}.',
      'Research question: ' + (topic.question || topic.title) + '\nPart: ' + part.title + '\nWhat to find out: ' + (part.description || '') +
      (followup ? '\nFollow-up from the researcher: ' + followup : '') +
      '\nWrite ' + depth.queries + ' short English search queries (3–8 words each) for a scholarly database. Cover different angles. No quotes or operators.',
      (name) => log(runId, 'Asking ' + name + ' to plan searches'));
    const qs = (out.queries || []).map((q) => String(q).slice(0, 120)).filter(Boolean);
    return qs.length ? qs.slice(0, depth.queries) : base.slice(0, depth.queries);
  } catch (e) {
    await log(runId, 'AI planning failed (' + e.message + ') — using keywords from the brief instead');
    return [...new Set(base.filter(Boolean))].slice(0, depth.queries);
  }
}
// The researcher can stop a run, and the watchdog ends runs that hang; either way the job must not overwrite it.
async function alive(runId) { const r = await db('agent_runs').where({ id: runId }).select('status').first(); return !!r && r.status === 'running'; }
class Stopped extends Error {}

function rank(found, keep) {
  const seen = new Map();
  found.forEach((s, i) => {
    const k = (s.key || s.title).toLowerCase();
    if (!seen.has(k)) seen.set(k, { ...s, order: i });
  });
  const scored = [...seen.values()].map((s) => ({ ...s, score: -s.order + Math.log10(1 + (s.cited_by || 0)) * 3 + (s.abstract && s.abstract.length > 200 ? 2 : 0) }));
  // Background articles get up to 2 reserved places so scholarly results can't crowd them out entirely.
  const wiki = scored.filter((s) => s.kind === 'wiki').slice(0, 2);
  const rest = scored.filter((s) => s.kind !== 'wiki').sort((a, b) => b.score - a.score).slice(0, Math.max(1, keep - wiki.length));
  return rest.concat(wiki);
}

async function synthesize(topic, part, followup, sources, depth, runId) {
  const list = sources.map((s) => '[' + s.n + '] ' + s.title + (s.authors ? ' — ' + s.authors : '') + (s.year ? ' (' + s.year + ')' : '') + (s.venue ? '. ' + s.venue : '') + '\nAbstract: ' + (s.abstract || '').slice(0, 1000)).join('\n\n');
  const out = await llm.json(
    'You are a careful research assistant. Use ONLY the numbered sources given. Never invent sources, numbers, quotes or facts that are not in them. ' +
    'If the sources do not answer something, say so under gaps. Write in plain English for a researcher. Reply with JSON only.',
    'Research question: ' + (topic.question || topic.title) + '\nYour part: ' + part.title + '\nWhat to find out: ' + (part.description || '') +
    (followup ? '\nThe researcher asked you to dig deeper: ' + followup : '') +
    '\n\nSources:\n' + list +
    '\n\nReturn JSON exactly like: {"summary": "3-5 sentences answering this part", "confidence": "High|Medium|Low", ' +
    '"findings": [{"text": "one clear finding, 1-2 sentences", "confidence": "High|Medium|Low", "cites": [1, 3]}], "gaps": ["what the sources could not answer"]}. ' +
    'Give ' + depth.findings + ' findings. Every finding must cite at least one source number from the list. Confidence is High only when several good sources agree.',
    (name) => log(runId, 'Asking ' + name + ' to write findings from ' + sources.length + ' sources'));
  const n = sources.length;
  const okConf = (c) => (['High', 'Medium', 'Low'].includes(c) ? c : 'Medium');
  const findings = (out.findings || []).map((f) => ({
    text: String(f.text || '').trim().slice(0, 1200), confidence: okConf(f.confidence),
    cites: [...new Set((f.cites || []).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= n))]
  })).filter((f) => f.text && f.cites.length);
  if (!findings.length) throw new Error('The AI reply had no findings that cite the sources.');
  return { by: out._by, summary: String(out.summary || '').slice(0, 3000), confidence: okConf(out.confidence), findings, gaps: (out.gaps || []).map((g) => String(g).slice(0, 400)).filter(Boolean).slice(0, 8) };
}

function extractive(sources) {
  const top = sources.filter((s) => s.abstract).slice(0, 6);
  return {
    summary: 'This agent found ' + sources.length + ' sources for this part. No AI service is connected, so these findings are the opening lines of the most relevant sources rather than a written summary. Read them as leads to check.',
    confidence: 'Low',
    findings: top.map((s) => ({ text: firstSentences(s.abstract, 2), confidence: 'Low', cites: [s.n] })),
    gaps: ['Connect a free AI service (GEMINI_API_KEY) to get written summaries and findings that compare sources.']
  };
}

async function execute(runId) {
  const run = await db('agent_runs').where({ id: runId }).first();
  if (!run || run.status !== 'running') return;
  const part = await db('parts').where({ id: run.part_id }).first();
  const topic = await db('topics').where({ id: run.topic_id }).first();
  if (!part || !topic) return;
  const depth = DEPTH[part.agent_depth] || DEPTH.standard;
  const kinds = String(part.agent_sources || 'papers,wiki').split(',').filter(Boolean);
  const since = /^\d{4}$/.test(String(topic.agent_since || '')) ? topic.agent_since : null;
  try {
    await db('parts').where({ id: part.id }).update({ agent_status: 'running' });
    await step(part, 8, 'Planning searches');
    const queries = await planQueries(topic, part, run.followup, depth, runId);
    if (!(await alive(runId))) throw new Stopped();
    await log(runId, 'Planned ' + queries.length + ' searches: ' + queries.map((q) => '“' + q + '”').join(', '));
    const found = [];
    const scholarly = kinds.filter((k) => research.SOURCE_TYPES[k] && research.SOURCE_TYPES[k].search);
    const total = Math.max(1, scholarly.length * queries.length);
    let i = 0;
    for (const k of scholarly) {
      const src = research.SOURCE_TYPES[k];
      let failures = 0;
      for (const q of queries) {
        await step(part, 15 + Math.round((i++ / total) * 40), 'Searching ' + src.label + ': ' + q);
        if (failures >= 2) continue; // this service is down or busy — don't keep hammering it
        try { const r = await src.search(q, { since, limit: depth.perQuery }); found.push(...r); await log(runId, src.label + ': “' + q + '” — ' + r.length + ' results'); }
        catch (e) { failures++; await log(runId, src.label + ' search failed for “' + q + '”: ' + e.message); }
        if (!(await alive(runId))) throw new Stopped();
      }
    }
    if (kinds.includes('wiki')) {
      await step(part, 58, 'Reading background on Wikipedia');
      try { const r = await research.searchWiki(part.title, { limit: 2 }); found.push(...r); await log(runId, 'Read ' + r.length + ' Wikipedia article' + (r.length === 1 ? '' : 's') + ' for background'); }
      catch (e) { await log(runId, 'Wikipedia search failed: ' + e.message); }
    }
    const picked = rank(found, depth.keep).map((s, k) => ({ ...s, n: k + 1 }));
    if (!picked.length) throw new Error('No sources were found. Try a broader brief, more source types or an earlier year.');
    await step(part, 65, 'Reading ' + picked.length + ' sources');
    await db('agent_sources').insert(picked.map((s) => ({ run_id: runId, n: s.n, kind: s.kind, title: s.title.slice(0, 1000), authors: s.authors || null, year: s.year || null, venue: s.venue ? s.venue.slice(0, 300) : null, url: s.url || null, doi: s.doi || null, cited_by: s.cited_by || 0, abstract: s.abstract || null })));
    await log(runId, 'Kept the ' + picked.length + ' most relevant sources out of ' + found.length);
    let result, model = 'none';
    if (llm.available()) {
      await step(part, 75, 'Writing findings from the sources');
      try { result = await synthesize(topic, part, run.followup, picked, depth, runId); model = result.by || llm.label(); }
      catch (e) { await log(runId, 'AI summary failed (' + e.message + ') — listing key sentences instead'); result = extractive(picked); }
    } else {
      result = extractive(picked);
    }
    if (!(await alive(runId))) throw new Stopped();
    await db('agent_findings').insert(result.findings.map((f, k) => ({ run_id: runId, part_id: part.id, position: k, text: f.text, confidence: f.confidence, cites: f.cites.join(','), kept: true })));
    await db('agent_runs').where({ id: runId }).update({ status: 'done', summary: result.summary, confidence: result.confidence, gaps: result.gaps.join('\n'), model, finished_at: now() });
    await log(runId, 'Handed back ' + result.findings.length + ' findings for review');
    await db('parts').where({ id: part.id }).update({ agent_status: 'review', agent_progress: 100, agent_step: 'Findings ready for review' });
    const leaders = await topicLeaders(topic.id);
    await notify(leaders, { kind: 'review', title: (part.agent_name || 'Agent') + ' finished “' + part.title + '”', body: result.findings.length + ' findings from ' + picked.length + ' sources', link: '/topics/' + topic.id + '/agents/' + part.id });
    await audit(null, topic.id, 'agent.finished', (part.agent_name || 'Agent') + ' handed back ' + result.findings.length + ' findings for “' + part.title + '”');
  } catch (e) {
    if (e instanceof Stopped || !(await alive(runId))) return; // already stopped by the researcher or the watchdog
    await db('agent_runs').where({ id: runId }).update({ status: 'failed', error: String(e.message).slice(0, 1000), finished_at: now() });
    await db('parts').where({ id: part.id }).update({ agent_status: 'failed', agent_step: String(e.message).slice(0, 240) });
    await log(runId, 'Stopped: ' + e.message);
  }
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift();
    active++;
    execute(id).catch(() => {}).finally(() => { active--; if (testHook) testHook(id); pump(); });
  }
}

async function launch(topic, part, userId, followup) {
  const runId = await db.insertId('agent_runs', { topic_id: topic.id, part_id: part.id, status: 'running', followup: followup || null, created_by: userId, started_at: now() });
  await db('parts').where({ id: part.id }).update({ agent_status: 'queued', agent_progress: 0, agent_step: 'Waiting to start' });
  await log(runId, followup ? 'Asked to dig deeper: ' + followup : 'Launched');
  queue.push(runId);
  setImmediate(pump);
  return runId;
}

// After a restart, runs that were in progress can't continue.
async function recover() {
  try {
    const stuck = await db('agent_runs').where({ status: 'running' }).select('id', 'part_id');
    if (!stuck.length) return;
    await db('agent_runs').whereIn('id', stuck.map((r) => r.id)).update({ status: 'failed', error: 'The server restarted while this agent was working. Run it again.', finished_at: now() });
    await db('parts').whereIn('id', stuck.map((r) => r.part_id)).whereIn('agent_status', ['queued', 'running']).update({ agent_status: 'failed', agent_step: 'Interrupted by a server restart — run it again' });
  } catch (e) { /* tables may not exist yet */ }
}

// Ends runs that have been going far too long (e.g. the server slept or a service hung).
const MAX_MIN = parseInt(process.env.AGENT_MAX_MINUTES || '12', 10);
async function watchdog() {
  const cutoff = new Date(Date.now() - MAX_MIN * 60000).toISOString();
  const stuck = await db('agent_runs').where({ status: 'running' }).where('started_at', '<', cutoff).select('id', 'part_id');
  for (const r of stuck) {
    await db('agent_runs').where({ id: r.id }).update({ status: 'failed', error: 'This run took longer than ' + MAX_MIN + ' minutes and was stopped. Run it again — if it keeps happening, an AI or search service may be down.', finished_at: now() });
    await db('parts').where({ id: r.part_id }).whereIn('agent_status', ['queued', 'running']).update({ agent_status: 'failed', agent_step: 'Took too long — run it again' });
    await log(r.id, 'Stopped by the watchdog after ' + MAX_MIN + ' minutes');
  }
}
async function stop(part, userName) {
  const run = await db('agent_runs').where({ part_id: part.id, status: 'running' }).orderBy('id', 'desc').first();
  if (run) {
    await db('agent_runs').where({ id: run.id }).update({ status: 'failed', error: 'Stopped by ' + userName + '.', finished_at: now() });
    await log(run.id, 'Stopped by ' + userName);
    const i = queue.indexOf(run.id); if (i >= 0) queue.splice(i, 1);
  }
  const prev = await db('agent_runs').where({ part_id: part.id, status: 'done' }).orderBy('id', 'desc').first();
  await db('parts').where({ id: part.id }).update({ agent_status: prev ? 'review' : 'draft', agent_progress: 0, agent_step: 'Stopped' });
}

async function suggestParts(question, title) {
  const out = await llm.json(
    'You help a researcher split a research question into parts that separate AI research agents can each investigate. Reply with JSON only.',
    'Topic: ' + title + '\nResearch question: ' + question +
    '\nSuggest 3 to 6 parts. Return {"parts": [{"title": "short title", "brief": "1-2 sentences: what this agent should find out", "agent": "short agent name, e.g. Hydrology agent"}]}');
  return (out.parts || []).map((p) => ({ title: String(p.title || '').slice(0, 200), brief: String(p.brief || '').slice(0, 1000), agent: String(p.agent || '').slice(0, 100) })).filter((p) => p.title.length > 2).slice(0, 8);
}

async function draftSection(topic, section, items) {
  const list = items.map((f) => '- ' + f.text + ' ' + f.marks).join('\n');
  const out = await llm.json(
    'You help a researcher draft one section of an academic paper from findings they accepted. Use only these findings. Keep every citation marker exactly as given, e.g. [src:12]. Reply with JSON only.',
    'Paper topic: ' + topic.title + '\nResearch question: ' + (topic.question || '') + '\nSection: ' + section.title + '\n\nAccepted findings with citation markers:\n' + list +
    '\n\nWrite 2-4 well-connected paragraphs in an academic but plain style. Put the citation markers right after the sentences they support. Return {"text": "..."} with paragraphs separated by blank lines.');
  return String(out.text || '').trim();
}

module.exports = { launch, recover, watchdog, stop, suggestParts, draftSection, DEPTH, keywords, firstSentences, _onFinish: (fn) => { testHook = fn; } };
