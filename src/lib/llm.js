'use strict';
// One small interface over free AI services. Pick one by setting its key on the server:
//   GEMINI_API_KEY  – Google AI Studio (free tier). Optional GEMINI_MODEL (default: gemini-flash-latest).
//   GROQ_API_KEY    – Groq (free tier, Llama models). Optional GROQ_MODEL.
//   LLM_API_KEY + LLM_BASE_URL (+ LLM_MODEL) – any OpenAI-compatible service, e.g. OpenRouter free models.
// With no key, agents still collect real sources but can't write summaries (see agent.js).

const TIMEOUT = parseInt(process.env.LLM_TIMEOUT_MS || '90000', 10);
let geminiModel = null; // resolved once, then reused

function provider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) return 'openai';
  return null;
}
function available() { return !!provider(); }
function label() {
  const p = provider();
  if (p === 'gemini') return 'Google Gemini (' + (geminiModel || process.env.GEMINI_MODEL || 'gemini-flash-latest') + ')';
  if (p === 'groq') return 'Groq (' + (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile') + ')';
  if (p === 'openai') return process.env.LLM_MODEL || 'AI model';
  return 'No AI service connected';
}

async function call(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      if (res.status === 429 || res.status === 503) { await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); continue; }
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
      if (!res.ok) { const err = new Error('AI service error ' + res.status + ': ' + ((body && body.error && (body.error.message || body.error)) || text).toString().slice(0, 300)); err.status = res.status; throw err; }
      return body;
    }
    throw new Error('The AI service is busy (rate limit). Try again in a minute.');
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

async function openaiCompatible(system, prompt) {
  const groq = provider() === 'groq';
  const base = groq ? 'https://api.groq.com/openai/v1' : process.env.LLM_BASE_URL.replace(/\/$/, '');
  const key = groq ? process.env.GROQ_API_KEY : process.env.LLM_API_KEY;
  const model = groq ? (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile') : process.env.LLM_MODEL;
  const out = await call(base + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
  });
  return ((((out.choices || [])[0] || {}).message || {}).content) || '';
}

function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('The AI reply was not in the expected format.');
  return JSON.parse(s.slice(a, b + 1));
}

// Ask for a JSON object. Throws if no service is connected or the reply can't be read.
async function json(system, prompt) {
  const p = provider();
  if (!p) throw new Error('No AI service is connected.');
  const text = p === 'gemini' ? await gemini(system, prompt) : await openaiCompatible(system, prompt);
  return parseJson(text);
}

module.exports = { available, label, json, parseJson, provider };
