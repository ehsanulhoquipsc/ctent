'use strict';
// More AI services and the AI allowance meter: the services back each other up in order, daily limits are
// read from the services' own headers, a used-up service rests until it refills, every call is counted,
// and admins and leaders (only) see how much is left.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const tmp = path.join(os.tmpdir(), 'ctent-ai-' + process.pid + '.sqlite');
process.env.SQLITE_FILE = tmp;
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'g-key';
process.env.CEREBRAS_API_KEY = 'c-key';
process.env.GROQ_API_KEY = 'q-key';
process.env.CLOUDFLARE_API_TOKEN = 'cf-token'; // no account id: must not count as connected
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.LLM_ORDER;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;

const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');
const llm = require('../src/lib/llm');
const ai = require('../src/lib/ai-status');
let app;

// A stand-in for the internet: each service answers as scripted.
const script = {};
const seen = [];
const realFetch = global.fetch;
function reply(status, body, headers = {}) { return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }); }
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const who = /generativelanguage/.test(u) ? 'gemini' : /cerebras/.test(u) ? 'cerebras' : /groq/.test(u) ? 'groq' : 'other';
  const body = opts.body ? JSON.parse(opts.body) : {};
  seen.push({ who, json: !!body.response_format });
  const fn = script[who];
  if (!fn) return reply(500, { error: { message: 'not scripted' } });
  return fn(body);
};
const okChat = (obj, headers) => reply(200, { choices: [{ message: { content: JSON.stringify(obj) } }] }, headers);
const okGemini = (obj) => reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
async function signIn(email) {
  const a = request.agent(app);
  const pg = await a.get('/login');
  await a.post('/login').type('form').send({ _csrf: csrfOf(pg.text), email, password: 'demo1234' });
  return a;
}

before(async () => {
  if (db.isPg) { await db.raw('drop schema public cascade'); await db.raw('create schema public'); }
  await db.migrate.latest();
  await seedDemo();
  llm.record.inTests = true;
  app = createApp();
});
after(async () => { global.fetch = realFetch; await db.destroy(); try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });
beforeEach(async () => {
  for (const k of Object.keys(script)) delete script[k];
  for (const k of Object.keys(llm.exhausted)) delete llm.exhausted[k];
  for (const k of Object.keys(llm.restingUntil)) delete llm.restingUntil[k];
  for (const k of Object.keys(llm.reported)) delete llm.reported[k];
  seen.length = 0;
  await db('ai_usage').del();
});
const settle = () => new Promise((r) => setTimeout(r, 60));

test('connected services and their order: Gemini first, then Cerebras, then Groq; Cloudflare needs both its values', () => {
  assert.deepEqual(llm.providers(), ['gemini', 'cerebras', 'groq']);
  process.env.LLM_ORDER = 'groq, cerebras';
  assert.deepEqual(llm.providers(), ['groq', 'cerebras', 'gemini']);
  delete process.env.LLM_ORDER;
  assert.match(llm.label(), /Google Gemini .* \+ backup Cerebras .* \+ backup Groq/);
});

test('resets: Gemini at midnight Pacific time, the others at midnight UTC', () => {
  const from = new Date('2026-11-21T10:00:00Z');
  assert.equal(llm.resetAt('groq', from).toISOString(), '2026-11-22T00:00:00.000Z');
  assert.equal(llm.resetAt('gemini', from).toISOString(), '2026-11-22T08:00:00.000Z'); // PST = UTC-8
});

test('when Gemini’s daily quota is used up, the next service answers, Gemini rests and its limit is learned', async () => {
  script.gemini = () => reply(429, { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 per day', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }] } });
  script.cerebras = () => okChat({ answer: 'from cerebras' }, { 'x-ratelimit-limit-requests-day': '14400', 'x-ratelimit-remaining-requests-day': '14399' });
  const out = await llm.json('Reply with JSON only.', 'hello');
  assert.equal(out.answer, 'from cerebras');
  assert.match(out._by, /Cerebras/);
  assert.ok(llm.restingUntil.gemini > Date.now());
  assert.equal(llm.exhausted.gemini, llm.dayKey('gemini'));
  // Next call skips Gemini without asking it again.
  seen.length = 0;
  await llm.json('Reply with JSON only.', 'again');
  assert.deepEqual(seen.map((s) => s.who), ['cerebras']);
  await settle();
  const st = await ai.status();
  const g = st.services.find((s) => s.id === 'gemini');
  const c = st.services.find((s) => s.id === 'cerebras');
  assert.equal(g.state, 'out');
  assert.equal(g.remaining, 0);
  assert.equal(g.limit, 20); // learned from the error
  assert.equal(g.source, 'learned');
  assert.equal(c.source, 'reported');
  assert.equal(c.limit, 14400);
  assert.equal(c.remaining, 14399); // the last number Cerebras reported
  assert.equal(c.used, 2);
});

test('Groq’s own headers give the exact number left; a model without JSON mode is asked again without it', async () => {
  llm.exhausted.gemini = llm.dayKey('gemini'); llm.restingUntil.gemini = Date.now() + 60000;
  script.cerebras = (b) => b.response_format ? reply(400, { error: { message: 'response_format is not supported by this model' } }) : okChat({ ok: 1 });
  const a = await llm.json('Reply with JSON only.', 'x');
  assert.equal(a.ok, 1);
  assert.deepEqual(seen.map((s) => [s.who, s.json]), [['cerebras', true], ['cerebras', false]]);
  delete script.cerebras;
  script.groq = () => okChat({ ok: 2 }, { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '640' });
  const b = await llm.json('Reply with JSON only.', 'y');
  assert.equal(b.ok, 2);
  await settle();
  const st = await ai.status();
  const q = st.services.find((s) => s.id === 'groq');
  assert.equal(q.remaining, 640);
  assert.equal(q.limit, 1000);
  assert.equal(q.pct, 64);
  assert.equal(q.state, 'ok');
});

test('every call is counted per service, day and feature; a service’s error counts as a failure', async () => {
  script.gemini = () => okGemini({ ok: true });
  await llm.json('x', 'y');
  await llm.json('x', 'y');
  script.gemini = () => reply(500, { error: { message: 'boom' } });
  script.cerebras = () => okChat({ ok: true });
  await llm.json('x', 'y');
  await settle();
  const rows = await db('ai_usage').whereNot('day', 'limit').orderBy('provider');
  const g = rows.find((r) => r.provider === 'gemini');
  assert.equal(Number(g.calls), 3);
  assert.equal(Number(g.fails), 1);
  assert.equal(g.day, llm.dayKey('gemini'));
  assert.equal(g.feature, 'other');
  assert.equal(llm.featureOf('Error\n    at draftSection (/app/src/lib/agent.js:580:10)'), 'paper');
  assert.equal(llm.featureOf('Error\n    at execute (/app/src/lib/publish.js:200:3)'), 'publish');
  assert.equal(llm.featureOf('Error\n    at extract (/app/src/lib/agent.js:320:3)'), 'agents');
  const h = await ai.history();
  assert.equal(h.perDay.length, 7);
  assert.equal(h.perDay[6].label, 'Today');
  assert.ok(h.total >= 4);
});

test('the meter: low and used-up states, and the line shown by the launch button', async () => {
  for (const p of ['gemini', 'cerebras', 'groq']) llm.exhausted[p] = llm.dayKey(p);
  let st = await ai.status();
  assert.equal(st.state, 'out');
  assert.equal(st.left, 0);
  assert.ok(st.nextRefill && st.nextRefill.text);
  assert.equal(ai.launchLine(st).level, 'out');
  delete llm.exhausted.groq;
  llm.reported.groq = { day: llm.dayKey('groq'), limit: 1000, remaining: 12, at: Date.now() };
  st = await ai.status();
  assert.equal(st.state, 'low');
  assert.equal(ai.launchLine(st).level, 'low');
  assert.match(ai.launchLine(st).text, /12 AI calls left/);
});

test('pages: admins see the Home card and Admin console › AI services; leaders see the card; members see neither', async () => {
  const admin = await db('users').where({ platform_role: 'admin', status: 'active' }).first();
  const leader = await db('users').where({ platform_role: 'leader', status: 'active' }).first();
  const member = await db('users').where({ platform_role: 'member', status: 'active' }).first();
  script.groq = () => okChat({ ok: 1 }, { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '900' });
  llm.exhausted.gemini = llm.dayKey('gemini'); llm.restingUntil.gemini = Date.now() + 60000;
  llm.exhausted.cerebras = llm.dayKey('cerebras'); llm.restingUntil.cerebras = Date.now() + 60000;
  await llm.json('x', 'y');
  await settle();

  const a = await signIn(admin.email);
  const home = await a.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /AI allowance today/);
  assert.match(home.text, /href="\/admin\/ai"/);
  assert.match(home.text, /Used up · back/);
  const page = await a.get('/admin/ai');
  assert.equal(page.status, 200);
  assert.match(page.text, /AI services/);
  assert.match(page.text, /Reported by the service/);
  assert.match(page.text, /900/);
  assert.match(page.text, /CEREBRAS_API_KEY/);
  assert.match((await a.get('/admin')).text, /href="\/admin\/ai"/);
  const csrf = csrfOf(page.text);
  const chk = await a.post('/admin/ai/check').type('form').send({ _csrf: csrf });
  assert.equal(chk.status, 302);

  const l = await signIn(leader.email);
  const lh = await l.get('/');
  assert.match(lh.text, /AI allowance today/);
  assert.doesNotMatch(lh.text, /href="\/admin\/ai"/);
  assert.equal((await l.get('/admin/ai')).status, 403);

  const m = await signIn(member.email);
  assert.doesNotMatch((await m.get('/')).text, /AI allowance today/);
});

test('the launch button on a project’s Research page tells the leader whether there’s enough AI', async () => {
  const lead = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').join('topics', 'topics.id', 'topic_members.topic_id')
    .where({ 'topic_members.role': 'leader', 'users.platform_role': 'leader', 'topics.mode': 'agent' }).whereNot('topics.status', 'archived')
    .whereExists(db('parts').whereRaw('parts.topic_id = topics.id')).orderBy('topics.id').select('topic_members.topic_id', 'users.email').first();
  for (const p of ['gemini', 'cerebras', 'groq']) llm.exhausted[p] = llm.dayKey(p);
  const l = await signIn(lead.email);
  const res = await l.get('/topics/' + lead.topic_id + '/agents');
  assert.equal(res.status, 200);
  assert.match(res.text, /\+ Add a part/);
  assert.match(res.text, /AI is used up for today/);
});
