'use strict';
// The AI allowance meter: how much each connected AI service can still do today.
// OpenRouter, Groq and Cerebras report their own numbers; for the others CTENT counts its calls
// against the daily limit (learned from the service, set as <NAME>_DAILY_LIMIT, or a known default).
const db = require('../db');
const llm = require('./llm');

const FEATURES = { agents: 'Research agents', paper: 'Paper writing and checks', publish: 'Publish', other: 'Other (summaries, titles)' };
const FALLBACK = { agents: 30, publish: 12 };
const TEST = process.env.NODE_ENV === 'test';

// OpenRouter tells you exactly how many free-model requests are left today.
let orCache = null;
async function openRouterKey() {
  if (orCache && Date.now() - orCache.at < 5 * 60 * 1000) return orCache.v;
  let v = null;
  try {
    const body = await Promise.race([llm.call('https://openrouter.ai/api/v1/key', { headers: { authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY } }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3000))]);
    const d = (body && body.data) || {};
    const f = d.free_model_daily_requests;
    if (f && Number.isFinite(Number(f.limit))) v = { limit: Number(f.limit), remaining: Math.max(0, Number(f.remaining != null ? f.remaining : f.limit - (f.used || 0))) };
  } catch (e) { v = null; }
  orCache = { at: Date.now(), v };
  return v;
}
function forget() { orCache = null; }

function fmtTime(d) { return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: require('./util').TZ }).replace(/\s/g, ' ').toLowerCase(); }
function inHM(d) { const m = Math.max(1, Math.round((d.getTime() - Date.now()) / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); }

async function status(opts = {}) {
  const list = llm.providers();
  if (!list.length) return { on: false, services: [] };
  const days = list.map((p) => llm.dayKey(p));
  const [rows, learned] = await Promise.all([
    db('ai_usage').whereIn('day', [...new Set(days)]).whereIn('provider', list).select('provider', 'day').sum({ n: 'calls' }).groupBy('provider', 'day'),
    db('ai_usage').where({ day: 'limit' }).whereIn('provider', list).select('provider', 'calls')
  ]);
  const usedOf = (p) => Number((rows.find((r) => r.provider === p && r.day === llm.dayKey(p)) || {}).n || 0);
  const learnedOf = (p) => Number((learned.find((r) => r.provider === p) || {}).calls || 0) || null;
  const or = list.includes('openrouter') && !TEST && opts.live !== false ? await openRouterKey() : null;

  const services = list.map((p, i) => {
    const S = llm.SERVICES[p];
    const today = llm.dayKey(p);
    const used = usedOf(p);
    const rep = p === 'openrouter' && or ? or : (llm.reported[p] && llm.reported[p].day === today ? llm.reported[p] : null);
    const limit = rep ? rep.limit : llm.setLimit(p) || learnedOf(p) || S.limit || null;
    let remaining = rep ? rep.remaining : limit ? Math.max(0, limit - used) : null;
    const out = llm.exhausted[p] === today;
    if (out) remaining = 0;
    const source = rep ? 'reported' : limit ? (llm.setLimit(p) ? 'set' : learnedOf(p) ? 'learned' : 'default') : 'unknown';
    const state = out || remaining === 0 ? 'out' : limit && remaining / limit < 0.2 ? 'low' : limit ? 'ok' : 'open';
    const reset = llm.resetAt(p);
    return { id: p, n: i + 1, name: S.name, model: S.model(), used, limit, remaining, source, state, pct: limit ? Math.round((remaining / limit) * 100) : null, resetAt: reset, resetText: fmtTime(reset), resetIn: inHM(reset) };
  });

  // How many calls a typical run takes, from the last two weeks (else a sensible guess).
  const since = new Date(Date.now() - 14 * 86400000);
  const sinceDay = since.toISOString().slice(0, 10);
  const [byF, agentRuns, pubRuns] = await Promise.all([
    db('ai_usage').where('day', '>=', sinceDay).whereNot('day', 'limit').select('feature').sum({ n: 'calls' }).groupBy('feature'),
    db('agent_runs').where('started_at', '>=', since.toISOString()).count({ n: '*' }).first(),
    db('publish_runs').where('created_at', '>=', since.toISOString()).count({ n: '*' }).first()
  ]);
  const callsF = (f) => Number((byF.find((r) => r.feature === f) || {}).n || 0);
  const per = (f, runs) => { const r = Number((runs || {}).n || 0); const c = callsF(f); return r >= 2 && c ? Math.min(150, Math.max(5, Math.round(c / r))) : FALLBACK[f]; };
  const perAgent = per('agents', agentRuns), perPublish = per('publish', pubRuns);

  const known = services.filter((s) => s.remaining != null);
  const open = services.filter((s) => s.state === 'open');
  const left = known.reduce((a, s) => a + s.remaining, 0);
  const state = !open.length && left === 0 ? 'out' : !open.length && left < perAgent * 2 ? 'low' : 'ok';
  const next = services.filter((s) => s.state === 'out').map((s) => s.resetAt).sort((a, b) => a - b)[0] || null;
  return {
    on: true, services, left, counted: known.length, open: open.map((s) => s.name), state, perAgent, perPublish,
    agentRuns: Math.floor(left / perAgent), publishRuns: Math.floor(left / perPublish),
    nextRefill: next ? { text: fmtTime(next), in: inHM(next) } : null,
    refills: [...new Set(services.map((s) => s.resetText))]
  };
}

// The last 7 days, and what used the calls.
async function history() {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const rows = await db('ai_usage').where('day', '>=', days[0]).whereNot('day', 'limit').select('day', 'feature', 'provider').sum({ n: 'calls' }).sum({ f: 'fails' }).groupBy('day', 'feature', 'provider');
  const perDay = days.map((d) => ({ day: d, label: d === days[6] ? 'Today' : new Date(d + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', timeZone: 'UTC' }), n: rows.filter((r) => r.day === d).reduce((a, r) => a + Number(r.n || 0), 0) }));
  const perFeature = Object.keys(FEATURES).map((k) => ({ key: k, label: FEATURES[k], n: rows.filter((r) => r.feature === k).reduce((a, r) => a + Number(r.n || 0), 0) }));
  const fails = rows.reduce((a, r) => a + Number(r.f || 0), 0);
  return { perDay, perFeature, max: Math.max(1, ...perDay.map((d) => d.n)), total: perDay.reduce((a, d) => a + d.n, 0), fails };
}

// One short line for a launch button.
function launchLine(st) {
  if (!st || !st.on) return null;
  if (st.state === 'out') return { level: 'out', text: 'AI is used up for today. Agents can’t start until ' + (st.nextRefill ? st.nextRefill.text + ' (in ' + st.nextRefill.in + ')' : 'it refills') + '.' };
  if (st.open.length) return { level: 'ok', text: 'Enough AI for this run.' };
  if (st.left < st.perAgent) return { level: 'low', text: 'May stop partway: about ' + st.left + ' AI calls left today.' };
  if (st.state === 'low') return { level: 'low', text: 'Running low: about ' + st.left + ' AI calls left today.' };
  return { level: 'ok', text: 'Enough AI for this run.' };
}

module.exports = { status, history, launchLine, forget, FEATURES };
