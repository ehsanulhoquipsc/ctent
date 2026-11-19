'use strict';
// Log in with Telegram: signature checks, joining from an invite, approval, sign-in, and Profile › Ways to sign in.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const tmp = path.join(os.tmpdir(), 'ctent-tg-' + process.pid + '.sqlite');
process.env.SQLITE_FILE = tmp;
process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = '123456789:AAHtestTokenForUnitTestsOnly_xyz123';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;

const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');
const telegram = require('../src/lib/telegram');
let app;

function signed(fields) {
  const data = { auth_date: String(Math.floor(Date.now() / 1000)), ...fields };
  const check = Object.keys(data).sort().map((k) => k + '=' + data[k]).join('\n');
  const secret = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  return { ...data, hash: crypto.createHmac('sha256', secret).update(check).digest('hex') };
}
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

// Go through the Telegram round trip: start, come back to the callback page, post the signed details.
async function viaTelegram(agent, query, fields) {
  const start = await agent.get('/auth/telegram' + (query ? '?' + query : ''));
  assert.equal(start.status, 302);
  assert.match(start.headers.location, /^https:\/\/oauth\.telegram\.org\/auth\?bot_id=123456789&/);
  const cb = await agent.get('/auth/telegram/callback');
  assert.equal(cb.status, 200);
  assert.match(cb.text, /\/static\/js\/telegram\.js/);
  return agent.post('/auth/telegram/verify').type('form').send({ _csrf: csrfOf(cb.text), data: JSON.stringify(signed(fields)) });
}
async function signIn(email, password = 'demo1234') {
  const a = request.agent(app);
  const pg = await a.get('/login');
  await a.post('/login').type('form').send({ _csrf: csrfOf(pg.text), email, password });
  a.csrf = csrfOf((await a.get('/profile')).text);
  return a;
}

before(async () => {
  if (db.isPg) { await db.raw('drop schema public cascade'); await db.raw('create schema public'); }
  await db.migrate.latest();
  await seedDemo();
  app = createApp();
});
after(async () => { await db.destroy(); try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });

test('Telegram signatures: valid data is accepted, anything changed or old is refused', () => {
  const ok = telegram.verify(signed({ id: '555', first_name: 'Siam', last_name: 'Rahman', username: 'siam_r' }));
  assert.deepEqual(ok, { id: '555', name: 'Siam Rahman', username: 'siam_r' });
  const s = signed({ id: '555', first_name: 'Siam' });
  assert.throws(() => telegram.verify({ ...s, id: '556' }), /couldn’t be verified/);
  assert.throws(() => telegram.verify({ ...s, hash: 'a'.repeat(64) }), /couldn’t be verified/);
  assert.throws(() => telegram.verify(signed({ id: '555', first_name: 'Old', auth_date: String(Math.floor(Date.now() / 1000) - 3 * 86400) })), /too old/);
  assert.throws(() => telegram.verify(null), /didn’t send/);
});

test('sign-in and invite pages show Google/Telegram/email as equal choices', async () => {
  const login = await request(app).get('/login');
  assert.match(login.text, /class="tg-btn" href="\/auth\/telegram\?"/);
  const nadia = await signIn('nadia@ctent.demo');
  await nadia.post('/admin/invites').type('form').send({ _csrf: nadia.csrf, role: 'member', days: '7' });
  const inv = await db('invites').whereNull('topic_id').orderBy('id', 'desc').first();
  const j = await request(app).get('/join/' + inv.token);
  assert.match(j.text, /Create your account with/);
  assert.match(j.text, /href="\/auth\/telegram\?invite=/);
  assert.match(j.text, /class="email-choice"/);
  assert.match(j.text, /Create account and join/);
});

test('joining with Telegram from an invite: name, optional email, then waits for approval; then signs in', async () => {
  const nadia = await signIn('nadia@ctent.demo');
  await nadia.post('/admin/invites').type('form').send({ _csrf: nadia.csrf, role: 'member', days: '7' });
  const inv = await db('invites').whereNull('topic_id').orderBy('id', 'desc').first();
  const a = request.agent(app);
  const v = await viaTelegram(a, 'invite=' + inv.token, { id: '9001', first_name: 'Siam', last_name: 'Rahman', username: 'siam_r' });
  assert.equal(v.status, 302);
  assert.equal(v.headers.location, '/join/telegram');
  const page = await a.get('/join/telegram');
  assert.match(page.text, /Almost there/);
  assert.match(page.text, /value="Siam Rahman"/);
  assert.match(page.text, /@siam_r/);
  // An email someone else uses is refused (no taking over accounts by claiming an email).
  const taken = await a.post('/join/telegram').type('form').send({ _csrf: csrfOf(page.text), name: 'Siam Rahman', email: 'nadia@ctent.demo' });
  assert.equal(taken.status, 400);
  assert.match(taken.text, /already an account with that email/);
  const done = await a.post('/join/telegram').type('form').send({ _csrf: csrfOf(taken.text), name: 'Siam Rahman', email: '' });
  assert.equal(done.status, 200);
  assert.match(done.text, /almost there/);
  assert.match(done.text, /with Telegram/);
  const u = await db('users').where({ telegram_id: '9001' }).first();
  assert.equal(u.status, 'pending');
  assert.ok(telegram.isPlaceholder(u.email));
  assert.match(u.joined_via, /^Telegram · invite link/);
  // Admin sees them without a fake address, then approves.
  const adm = await nadia.get('/admin');
  assert.match(adm.text, /@siam_r/);
  assert.doesNotMatch(adm.text, /telegram\.invalid/);
  await nadia.post('/admin/approvals/' + u.id).type('form').send({ _csrf: csrfOf(adm.text), action: 'approve', role: 'member' });
  assert.equal((await db('users').where({ id: u.id }).first()).status, 'active');
  // Now Telegram signs them straight in.
  const b = request.agent(app);
  const s = await viaTelegram(b, '', { id: '9001', first_name: 'Siam', username: 'siam_r' });
  assert.equal(s.status, 302);
  assert.equal(s.headers.location, '/');
  const more = await b.get('/more');
  assert.equal(more.status, 200);
  assert.doesNotMatch(more.text, /telegram\.invalid/);
  // Profile: Telegram is the only way in, so it can't be removed; adding an email works.
  const prof = await b.get('/profile');
  assert.match(prof.text, /Ways to sign in/);
  assert.match(prof.text, /Add your email/);
  const rm = await b.post('/profile/telegram/remove').type('form').send({ _csrf: csrfOf(prof.text) });
  assert.equal(rm.status, 302);
  assert.ok((await db('users').where({ id: u.id }).first()).telegram_id);
  await b.post('/profile/email').type('form').send({ _csrf: csrfOf(prof.text), email: 'siam@example.org' });
  const u2 = await db('users').where({ id: u.id }).first();
  assert.equal(u2.email, 'siam@example.org');
  assert.equal(Boolean(u2.email_verified), false);
  // Setting a first password needs no old one, then counts as a second way in.
  await b.post('/profile/password').type('form').send({ _csrf: csrfOf(prof.text), password: 'a-long-password-1', password2: 'a-long-password-1' });
  assert.equal(Boolean((await db('users').where({ id: u.id }).first()).has_password), true);
});

test('Telegram with no account and no invite is refused; a forged or replayed sign-in is refused', async () => {
  const a = request.agent(app);
  const r = await viaTelegram(a, '', { id: '7777', first_name: 'Stranger' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login');
  assert.match((await a.get('/login')).text, /No CTENT account uses this Telegram account/);
  assert.equal(await db('users').where({ telegram_id: '7777' }).first(), undefined);
  // Without starting at /auth/telegram (no session record), even valid data is refused.
  const b = request.agent(app);
  const cb = await b.get('/auth/telegram/callback');
  await b.post('/auth/telegram/verify').type('form').send({ _csrf: csrfOf(cb.text), data: JSON.stringify(signed({ id: '9001', first_name: 'Siam' })) });
  assert.match((await b.get('/login')).text, /expired/);
  // Tampered data is refused.
  const c = request.agent(app);
  await c.get('/auth/telegram');
  const cb2 = await c.get('/auth/telegram/callback');
  const bad = { ...signed({ id: '9001', first_name: 'Siam' }), id: '1' };
  await c.post('/auth/telegram/verify').type('form').send({ _csrf: csrfOf(cb2.text), data: JSON.stringify(bad) });
  assert.match((await c.get('/login')).text, /couldn’t be verified/);
});

test('connect Telegram to an existing account from Profile, sign in with it, and remove it', async () => {
  const tom = await signIn('tom@ctent.demo');
  const v = await viaTelegram(tom, 'link=1', { id: '4242', first_name: 'Tom', username: 'tomw' });
  assert.equal(v.headers.location, '/profile#signin');
  const t = await db('users').where({ email: 'tom@ctent.demo' }).first();
  assert.equal(t.telegram_id, '4242');
  assert.equal(t.telegram_username, 'tomw');
  // Another account can't take the same Telegram account.
  const priya = await signIn('priya@ctent.demo');
  await viaTelegram(priya, 'link=1', { id: '4242', first_name: 'Tom' });
  assert.equal((await db('users').where({ email: 'priya@ctent.demo' }).first()).telegram_id, null);
  // Sign in with it.
  const b = request.agent(app);
  const s = await viaTelegram(b, '', { id: '4242', first_name: 'Tom' });
  assert.equal(s.headers.location, '/');
  // Remove it (Tom still has a password).
  const prof = await tom.get('/profile');
  await tom.post('/profile/telegram/remove').type('form').send({ _csrf: csrfOf(prof.text) });
  assert.equal((await db('users').where({ id: t.id }).first()).telegram_id, null);
});
