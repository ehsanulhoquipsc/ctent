'use strict';
// One small interface over free AI services. Pick one by setting its key on the server:
//   GEMINI_API_KEY  – Google AI Studio (free tier). Optional GEMINI_MODEL (default: gemini-flash-latest).
//   GROQ_API_KEY    – Groq (free tier, Llama models). Optional GROQ_MODEL.
//   OPENROUTER_API_KEY – OpenRouter (free models). Optional OPENROUTER_MODEL.
//   LLM_API_KEY + LLM_BASE_URL (+ LLM_MODEL) – any other OpenAI-compatible service.
// Set more than one and they back each other up: if one is busy or fails, the next is tried.
// With no key, agents still collect real sources but can't write summaries (see agent.js).

const TIMEOUT = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);
// Free tiers allow roughly 10-15 requests a minute, so calls are spaced out (shared by every running agent).
const GAP_MS = parseInt(process.env.LLM_MIN_INTERVAL_MS || (process.env.NODE_ENV === 'test' ? '0' : '4000'), 10);
let nextCall = 0;
async function pace() { const t = Date.now(); const at = Math.max(t, nextCall); nextCall = at + GAP_MS; if (at > t) await new Promise((r) => setTimeout(r, at - t)); }
let geminiModel = null; // resolved once, then reused

const OPENAI_LIKE = {
  groq: () => ({ base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', name: 'Groq' }),
  openrouter: () => ({ base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', name: 'OpenRouter' }),
  openai: () => ({ base: String(process.env.LLM_BASE_URL || '').replace(/\/$/, ''), key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, name: 'AI service' })
};
function providers() {
  const list = [];
  if (process.env.GEMINI_API_KEY) list.push('gemini');
  if (process.env.GROQ_API_KEY) list.push('groq');
  if (process.env.OPENROUTER_API_KEY) list.push('openrouter');
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) list.push('openai');
  return list;
}
function provider() { return providers()[0] || null; }
function available() { return providers().length > 0; }
function nameOf(p) {
  if (p === 'gemini') return 'Google Gemini (' + (geminiModel || process.env.GEMINI_MODEL || 'gemini-flash-latest') + ')';
  const c = OPENAI_LIKE[p](); return c.name + ' (' + c.model + ')';
}
function label() { const l = providers(); return l.length ? l.map(nameOf).join(' + backup ') : 'No AI service connected'; }

async function call(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      if (res.status === 429 || res.status === 503) { if (attempt === 0) await new Promise((r) => setTimeout(r, 5000)); continue; }
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
      if (!res.ok) { const err = new Error('AI service error ' + res.status + ': ' + ((body && body.error && (body.error.message || body.error)) || text).toString().slice(0, 300)); err.status = res.status; throw err; }
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
  const send = async (model) => call('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body });
  let out;
  try { out = await send(await pickGeminiModel(key)); } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    out = await send(await fallbackGeminiModel(key));
  }
  const parts = (((out.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
}

async function openaiCompatible(p, system, prompt) {
  const c = OPENAI_LIKE[p]();
  const out = await call(c.base + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
    body: JSON.stringify({ model: c.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
  });
  return ((((out.choices || [])[0] || {}).message || {}).content) || '';
}

function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('The AI reply was not in the expected format.');
  return JSON.parse(s.slice(a, b + 1));
}

// Ask for a JSON object. Tries each connected service in turn; throws if all of them fail.
async function json(system, prompt, onTry) {
  const list = providers();
  if (!list.length) throw new Error('No AI service is connected.');
  const errors = [];
  for (const p of list) {
    try {
      if (onTry) await onTry(nameOf(p));
      await pace();
      const text = p === 'gemini' ? await gemini(system, prompt) : await openaiCompatible(p, system, prompt);
      const out = parseJson(text);
      out._by = nameOf(p);
      return out;
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'timed out' : e.message;
      errors.push(nameOf(p) + ': ' + msg);
    }
  }
  throw new Error(errors.join(' · '));
}

module.exports = { available, label, json, parseJson, provider, providers };
