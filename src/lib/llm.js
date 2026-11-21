'use strict';
// One small interface over free AI services. Connect one by setting its key on the server (Render › Environment):
//   GEMINI_API_KEY      – Google AI Studio. Optional GEMINI_MODEL (default gemini-flash-latest), GEMINI_DAILY_LIMIT.
//   CEREBRAS_API_KEY    – Cerebras. Optional CEREBRAS_MODEL.
//   GROQ_API_KEY        – Groq. Optional GROQ_MODEL.
//   MISTRAL_API_KEY     – Mistral (La Plateforme, free “Experiment” plan). Optional MISTRAL_MODEL.
//   OPENROUTER_API_KEY  – OpenRouter free models. Optional OPENROUTER_MODEL.
//   SAMBANOVA_API_KEY   – SambaNova Cloud. Optional SAMBANOVA_MODEL.
//   NVIDIA_API_KEY      – NVIDIA API catalog (build.nvidia.com). Optional NVIDIA_MODEL.
//   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID – Cloudflare Workers AI. Optional CLOUDFLARE_MODEL.
//   LLM_API_KEY + LLM_BASE_URL (+ LLM_MODEL) – any other OpenAI-compatible service.
// Set several and they back each other up, in the order of LLM_ORDER (or the default order below):
// when one is busy, used up for the day or fails, the next one is tried.
// Any service also takes <NAME>_DAILY_LIMIT (requests a day) for the allowance meter when it doesn't report its own.

const TIMEOUT = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);
const TEST = process.env.NODE_ENV === 'test';
// Free tiers allow a limited number of requests a minute, so calls to the same service are spaced out.
const GAP_MS = parseInt(process.env.LLM_MIN_INTERVAL_MS || (TEST ? '0' : '4000'), 10);
const nextCall = {};
async function pace(p) {
  const gap = TEST ? 0 : (SERVICES[p] && SERVICES[p].gap) || GAP_MS;
  const t = Date.now(); const at = Math.max(t, nextCall[p] || 0); nextCall[p] = at + gap;
  if (at > t) await new Promise((r) => setTimeout(r, at - t));
}
let geminiModel = null; // resolved once, then reused
// When a service's DAILY free quota is used up, skip it until it refills (re-checked every 30 minutes).
const restingUntil = {};
const isDailyQuota = (m) => /PerDay|per day|daily|requests-day|RPD/i.test(String(m || ''));

// The service's "day": Google resets Gemini quotas at midnight Pacific time; the others at midnight UTC.
const dayIn = (tz, d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: tz });
function dayKey(p, d) { return dayIn(p === 'gemini' ? 'America/Los_Angeles' : 'UTC', d); }
function resetAt(p, from = new Date()) {
  // The first moment after `from` when the service's day changes.
  const today = dayKey(p, from);
  let lo = from.getTime(), hi = lo + 26 * 3600 * 1000;
  if (dayKey(p, new Date(hi)) === today) return new Date(hi);
  while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 2); if (dayKey(p, new Date(mid)) === today) lo = mid; else hi = mid; }
  return new Date(Math.floor(hi / 60000) * 60000);
}

const env = (k) => process.env[k];
const SERVICES = {
  gemini: { name: 'Google Gemini', key: () => env('GEMINI_API_KEY'), model: () => geminiModel || env('GEMINI_MODEL') || 'gemini-flash-latest', limit: 250 },
  cerebras: { name: 'Cerebras', base: () => 'https://api.cerebras.ai/v1', key: () => env('CEREBRAS_API_KEY'), model: () => env('CEREBRAS_MODEL') || 'gpt-oss-120b', json: true, gap: 2500 },
  groq: { name: 'Groq', base: () => 'https://api.groq.com/openai/v1', key: () => env('GROQ_API_KEY'), model: () => env('GROQ_MODEL') || 'llama-3.3-70b-versatile', json: true, limit: 1000 },
  mistral: { name: 'Mistral', base: () => 'https://api.mistral.ai/v1', key: () => env('MISTRAL_API_KEY'), model: () => env('MISTRAL_MODEL') || 'mistral-small-latest', json: true, gap: 2500 },
  openrouter: { name: 'OpenRouter', base: () => 'https://openrouter.ai/api/v1', key: () => env('OPENROUTER_API_KEY'), model: () => env('OPENROUTER_MODEL') || 'meta-llama/llama-3.3-70b-instruct:free', json: true, limit: 50 },
  sambanova: { name: 'SambaNova', base: () => 'https://api.sambanova.ai/v1', key: () => env('SAMBANOVA_API_KEY'), model: () => env('SAMBANOVA_MODEL') || 'Meta-Llama-3.3-70B-Instruct' },
  nvidia: { name: 'NVIDIA', base: () => 'https://integrate.api.nvidia.com/v1', key: () => env('NVIDIA_API_KEY'), model: () => env('NVIDIA_MODEL') || 'meta/llama-3.3-70b-instruct', gap: 2000 },
  cloudflare: { name: 'Cloudflare Workers AI', base: () => 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(env('CLOUDFLARE_ACCOUNT_ID') || '') + '/ai/v1', key: () => env('CLOUDFLARE_ACCOUNT_ID') && env('CLOUDFLARE_API_TOKEN'), model: () => env('CLOUDFLARE_MODEL') || '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  openai: { name: 'AI service', base: () => String(env('LLM_BASE_URL') || '').replace(/\/$/, ''), key: () => env('LLM_BASE_URL') && env('LLM_API_KEY'), model: () => env('LLM_MODEL'), json: true }
};
const DEFAULT_ORDER = ['gemini', 'cerebras', 'groq', 'mistral', 'openrouter', 'sambanova', 'nvidia', 'cloudflare', 'openai'];
function order() {
  const asked = String(env('LLM_ORDER') || '').toLowerCase().split(/[\s,]+/).filter((x) => SERVICES[x]);
  return [...new Set([...asked, ...DEFAULT_ORDER])];
}
function providers() { return order().filter((p) => SERVICES[p].key()); }
function provider() { return providers()[0] || null; }
function available() { return providers().length > 0; }
function nameOf(p) { return SERVICES[p].name + ' (' + SERVICES[p].model() + ')'; }
function label() { const l = providers(); return l.length ? l.map(nameOf).join(' + backup ') : 'No AI service connected'; }
// The daily request limit used by the meter: what the service last reported, else <NAME>_DAILY_LIMIT, else a known free-tier default.
function setLimit(p) { const v = parseInt(env(p.toUpperCase() + '_DAILY_LIMIT') || '', 10); return v > 0 ? v : null; }

// What the services tell us about their own limits (from response headers or error details), per service and day.
const reported = {}; // p -> { day, limit, remaining, at }
const exhausted = {}; // p -> day on which the daily quota ran out
function noteHeaders(p, h) {
  if (!h || !h.get) return;
  const num = (k) => { const v = h.get(k); const n = v == null ? NaN : parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  let limit = num('x-ratelimit-limit-requests-day'), remaining = num('x-ratelimit-remaining-requests-day');
  if (limit == null && p === 'groq') { limit = num('x-ratelimit-limit-requests'); remaining = num('x-ratelimit-remaining-requests'); }
  if (limit != null && remaining != null) reported[p] = { day: dayKey(p), limit, remaining, at: Date.now() };
}

// Count every call per service, day and feature (best effort: never slows or breaks a call).
function featureOf(stack) {
  const s = String(stack || '');
  if (/draftSection|routes[\\/]paper/.test(s)) return 'paper';
  if (/lib[\\/]publish|routes[\\/]publish/.test(s)) return 'publish';
  if (/lib[\\/](agent|evidence)|routes[\\/]agents/.test(s)) return 'agents';
  return 'other';
}
function record(p, feature, ok) {
  if (TEST && !record.inTests) return Promise.resolve();
  let db; try { db = require('../db'); } catch (e) { return Promise.resolve(); }
  const row = { day: dayKey(p), provider: p, feature, calls: 1, fails: ok ? 0 : 1 };
  return db('ai_usage').insert(row).onConflict(['day', 'provider', 'feature'])
    .merge({ calls: db.raw('ai_usage.calls + 1'), fails: db.raw('ai_usage.fails + ?', [ok ? 0 : 1]) }).catch(() => {});
}
function learnLimit(p, n) {
  if (!(n > 0)) return;
  let db; try { db = require('../db'); } catch (e) { return; }
  db('ai_usage').insert({ day: 'limit', provider: p, feature: 'other', calls: n, fails: 0 }).onConflict(['day', 'provider', 'feature']).merge({ calls: n }).catch(() => {});
}

async function call(url, opts, p) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      if (p) noteHeaders(p, res.headers);
      if (res.status === 429 || res.status === 503) {
        const busy = await res.text().catch(() => '');
        if (res.status === 429 && (isDailyQuota(busy) || (p && reported[p] && reported[p].remaining === 0))) { // waiting won't help today: fail fast so the backup is used
          const q = busy.match(/"quotaValue"\s*:\s*"?(\d+)/);
          if (p && q) learnLimit(p, parseInt(q[1], 10));
          const err = new Error('daily free quota used up: ' + busy.slice(0, 200)); err.status = 429; err.daily = true; throw err;
        }
        if (attempt === 0) await new Promise((r) => setTimeout(r, TEST ? 0 : 5000));
        continue;
      }
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
      if (!res.ok) { const err = new Error('AI service error ' + res.status + ': ' + ((body && body.error && (body.error.message || body.error)) || (body && body.errors && JSON.stringify(body.errors)) || text).toString().slice(0, 300)); err.status = res.status; throw err; }
      return body;
    }
    const err = new Error('The AI service is busy (free-tier limit reached). Try again in a minute.'); err.status = 429; throw err;
  } finally { clearTimeout(timer); }
}

async function pickGeminiModel(key) {
  if (geminiModel) return geminiModel;
  geminiModel = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  return geminiModel;
}
async function fallbackGeminiModel(key) {
  // The chosen name wasn't found: ask Google which flash models this key can use.
  const list = await call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  const names = (list.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  const pick = names.find((n) => /flash/.test(n) && !/lite|tts|image|live|audio/.test(n)) || names.find((n) => /flash/.test(n)) || names[0];
  if (!pick) throw new Error('No Gemini model is available for this API key.');
  geminiModel = pick;
  return pick;
}

async function gemini(system, prompt) {
  const key = process.env.GEMINI_API_KEY;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  });
  const send = async (model) => call('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body }, 'gemini');
  let out;
  try { out = await send(await pickGeminiModel(key)); } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    out = await send(await fallbackGeminiModel(key));
  }
  const parts = (((out.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
}

async function openaiCompatible(p, system, prompt) {
  const c = SERVICES[p];
  const send = (json) => call(c.base() + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key() },
    body: JSON.stringify({ model: c.model(), temperature: 0.2, ...(json ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
  }, p);
  let out;
  try { out = await send(c.json); } catch (e) {
    // Some models don't take JSON mode: ask again without it (the reply is still parsed as JSON).
    if (!(c.json && e.status === 400 && /response_format|json/i.test(e.message))) throw e;
    out = await send(false);
  }
  return ((((out.choices || [])[0] || {}).message || {}).content) || '';
}

// Models sometimes answer with a bare list (or a list holding one object) instead of the object we asked for.
// Always return a plain object so callers can read fields safely.
function shape(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  if (Array.isArray(data)) {
    const first = data.length === 1 && data[0] && typeof data[0] === 'object' && !Array.isArray(data[0]) ? data[0] : {};
    return { ...first, items: data, claims: data, gaps: data, questions: data, parts: data };
  }
  return {};
}
function parseJson(text) {
  const s = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return shape(JSON.parse(s)); } catch (e) { /* look for the JSON inside other text */ }
  const o1 = s.indexOf('{'), o2 = s.lastIndexOf('}'), a1 = s.indexOf('['), a2 = s.lastIndexOf(']');
  const tries = [];
  if (o1 >= 0 && o2 > o1) tries.push(s.slice(o1, o2 + 1));
  if (a1 >= 0 && a2 > a1) tries.push(s.slice(a1, a2 + 1));
  if (a1 >= 0 && a1 < o1) tries.reverse(); // the reply is a list of objects
  for (const t of tries) { try { return shape(JSON.parse(t)); } catch (e) { /* next */ } }
  throw new Error('The AI reply was not in the expected format.');
}

// Ask for a JSON object. Tries each connected service in turn; throws if all of them fail.
async function json(system, prompt, onTry) {
  const list = providers();
  if (!list.length) throw new Error('No AI service is connected.');
  const feature = featureOf(new Error().stack);
  const errors = [];
  for (const p of list) {
    if ((restingUntil[p] || 0) > Date.now()) { errors.push(nameOf(p) + ': daily free quota used up (resting)'); continue; }
    try {
      if (onTry) await onTry(nameOf(p));
      await pace(p);
      const text = p === 'gemini' ? await gemini(system, prompt) : await openaiCompatible(p, system, prompt);
      record(p, feature, true);
      const out = parseJson(text);
      out._by = nameOf(p);
      return out;
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'timed out' : e.message;
      if (e.status === 429 && (e.daily || isDailyQuota(msg))) {
        exhausted[p] = dayKey(p);
        restingUntil[p] = Math.min(resetAt(p).getTime(), Date.now() + 30 * 60 * 1000);
      } else if (e.status) record(p, feature, false);
      errors.push(nameOf(p) + ': ' + msg);
    }
  }
  throw new Error(errors.join(' · '));
}

module.exports = { available, label, json, parseJson, provider, providers, order, SERVICES, nameOf, dayKey, resetAt, setLimit, reported, exhausted, restingUntil, featureOf, record, call };
