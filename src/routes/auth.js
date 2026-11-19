'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../lib/auth');
const { audit } = require('../lib/events');
const { now, COLOR_NAMES } = require('../lib/util');
const google = require('../lib/google');
const telegram = require('../lib/telegram');
const invites = require('../lib/invites');
const approvals = require('../lib/approvals');
const crypto = require('crypto');

const r = express.Router();
const demoLogins = () => process.env.DEMO_LOGINS !== 'false';
const waiting = (res, user) => res.render('pages/pending', { title: 'Waiting for approval', person: user });
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

async function startSession(req, user) {
  await new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
  req.session.uid = user.id;
  await db('users').where({ id: user.id }).update({ last_login_at: now() });
}

// A page to share: how to install the CTENT app on any device, then sign in.
r.get('/app', (req, res) => res.render('pages/get-app', { title: 'Get the CTENT app', signedIn: !!req.user }));

r.get('/privacy', (req, res) => res.render('pages/privacy', { title: 'Privacy policy', contact: process.env.CONTACT_EMAIL || '' }));

r.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const count = Number((await db('users').count({ n: '*' }).first()).n);
  if (count === 0) return res.redirect('/setup');
  const demo = demoLogins() ? await db('users').where('email', 'like', '%@ctent.demo').where({ status: 'active' }).orderBy('id').select('id', 'name', 'email', 'platform_role', 'title') : [];
  res.render('pages/login', { title: 'Sign in', next: safeNext(req.query.next), error: req.session.loginError || null, email: '', demo, googleOn: google.configured(), tgOn: telegram.configured() });
  req.session.loginError = null;
});

r.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = req.ip + '|' + email;
  const demo = demoLogins() ? await db('users').where('email', 'like', '%@ctent.demo').where({ status: 'active' }).orderBy('id').select('id', 'name', 'email', 'platform_role', 'title') : [];
  const fail = (msg) => res.status(401).render('pages/login', { title: 'Sign in', next: safeNext(req.body.next), error: msg, email, demo, googleOn: google.configured(), tgOn: telegram.configured() });
  if (auth.tooManyAttempts(key)) return fail('Too many attempts. Wait 15 minutes and try again.');
  const user = await db('users').whereRaw('lower(email) = ?', [email]).first();
  if (!user || !bcrypt.compareSync(password, user.password_hash)) { auth.recordFailure(key); return fail('That email and password don’t match.'); }
  if (auth.demoBlocked(user)) return fail('Demo accounts are turned off. Sign in with your own account, or ask an admin for an invite link.');
  if (user.status === 'pending') return waiting(res, user);
  if (user.status !== 'active') return fail('This account is suspended. Contact your administrator.');
  auth.clearFailures(key);
  await audit(user.id, null, 'user.signin', 'Signed in with a password');
  await startSession(req, user);
  res.redirect(safeNext(req.body.next));
});

// One-click demo sign-in (only for the seeded @ctent.demo accounts). Turn off with DEMO_LOGINS=false.
r.post('/login/demo', async (req, res) => {
  if (!demoLogins()) return auth.notFound(res);
  const user = await db('users').where({ id: parseInt(req.body.id, 10), status: 'active' }).where('email', 'like', '%@ctent.demo').first();
  if (!user) return res.redirect('/login');
  await startSession(req, user);
  res.redirect('/');
});

r.post('/logout', (req, res) => { req.session.destroy(() => { res.clearCookie('ctent.sid'); res.redirect('/login'); }); });

r.get('/forgot', (req, res) => res.render('pages/forgot', { title: 'Reset password' }));

// First run: if the database has no users, the first person creates the admin account.
r.get('/setup', async (req, res) => {
  const count = Number((await db('users').count({ n: '*' }).first()).n);
  if (count > 0) return res.redirect('/login');
  res.render('pages/setup', { title: 'Create admin account', error: null, v: {} });
});
r.post('/setup', async (req, res) => {
  const count = Number((await db('users').count({ n: '*' }).first()).n);
  if (count > 0) return res.redirect('/login');
  const v = { name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim().toLowerCase(), institution: String(req.body.institution || '').trim() };
  const pw = String(req.body.password || '');
  let error = null;
  if (!v.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) error = 'Enter your name and a valid email.';
  else if (pw.length < 10) error = 'Use a password of at least 10 characters.';
  else if (pw !== req.body.password2) error = 'The two passwords don’t match.';
  if (error) return res.status(400).render('pages/setup', { title: 'Create admin account', error, v });
  const id = await db.insertId('users', { ...v, password_hash: bcrypt.hashSync(pw, 12), platform_role: 'admin', title: 'Platform administrator', color: 'burgundy', created_at: now() });
  await audit(id, null, 'admin.setup', 'Created the first admin account');
  await startSession(req, { id });
  res.redirect('/admin');
});

// ---------- Sign in with Google ----------
const signupOpen = () => process.env.GOOGLE_SIGNUP === 'open';
const loginError = (req, res, msg) => { req.session.loginError = msg; res.redirect('/login'); };

r.get('/auth/google', (req, res) => {
  if (!google.configured()) return auth.notFound(res);
  const state = google.newState();
  req.session.oauth = { state, next: safeNext(req.query.next), invite: String(req.query.invite || '').slice(0, 64) || null, link: !!(req.query.link && req.user), at: Date.now() };
  req.session.save(() => res.redirect(google.authUrl(req, state)));
});

r.get('/auth/google/callback', async (req, res) => {
  const o = req.session.oauth || {};
  req.session.oauth = null;
  if (!google.configured()) return auth.notFound(res);
  if (req.query.error) return loginError(req, res, req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in didn’t work. Try again.');
  if (!o.state || o.state !== req.query.state || Date.now() - (o.at || 0) > 10 * 60000) return loginError(req, res, 'That sign-in link expired. Try again.');
  let g;
  try { g = await google.exchange(req, String(req.query.code || '')); } catch (e) { return loginError(req, res, e.message); }
  // Connecting Google to the account you're signed in to (Profile › Ways to sign in).
  if (o.link && req.user) {
    const other = await db('users').where({ google_sub: g.sub }).whereNot('id', req.user.id).first();
    if (other) { req.flash('error', 'That Google account is already used by another CTENT account.'); return res.redirect('/profile#signin'); }
    const upd = { google_sub: g.sub };
    if (telegram.isPlaceholder(req.user.email) || (!req.user.email_verified && String(req.user.email).toLowerCase() === g.email)) {
      if (!(await db('users').whereRaw('lower(email) = ?', [g.email]).whereNot('id', req.user.id).first())) { upd.email = g.email; upd.email_verified = true; }
    }
    await db('users').where({ id: req.user.id }).update(upd);
    await audit(req.user.id, null, 'user.signin_method', 'Connected Google (' + g.email + ')');
    req.flash('ok', 'Google connected. You can now sign in with ' + g.email + '.');
    return res.redirect('/profile#signin');
  }
  const inv = o.invite ? await invites.find(o.invite) : null;
  let user = await db('users').where({ google_sub: g.sub }).first();
  if (!user) {
    const byEmail = await db('users').whereRaw('lower(email) = ?', [g.email]).first();
    // Only join a Google account to an existing account by email when that email was confirmed.
    if (byEmail && byEmail.email_verified === false) return loginError(req, res, 'An account already uses ' + g.email + ' but hasn’t confirmed it. Sign in to that account another way, then connect Google from your profile.');
    user = byEmail;
  }
  let created = false;
  if (user && auth.demoBlocked(user)) return loginError(req, res, 'Demo accounts are turned off. Sign in with your own account.');
  if (user) {
    if (!user.google_sub) await db('users').where({ id: user.id }).update({ google_sub: g.sub });
    if (user.status === 'pending') return waiting(res, user);
    if (user.status !== 'active') return loginError(req, res, 'This account is suspended. Contact your administrator.');
  } else if (inv || signupOpen()) {
    const role = inv ? invites.platformRole(inv) : 'member';
    const id = await db.insertId('users', { name: g.name.slice(0, 120), email: g.email, google_sub: g.sub, has_password: false, password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
      platform_role: role, color: COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)], created_at: now() });
    user = await db('users').where({ id }).first();
    created = true;
    await audit(id, inv ? inv.topic_id : null, 'user.joined', g.name + ' (' + g.email + ') joined with Google' + (inv ? ' from an invite link' : ''));
    if (inv) await db('invites').where({ id: inv.id }).increment('uses', 1);
    if ((await approvals.onSignup(user, inv, inv ? 'Google · invite link' : 'Google · open sign-up')).pending) return waiting(res, user);
  } else {
    return loginError(req, res, 'There’s no CTENT account for ' + g.email + ' yet. Ask a project leader for an invite link, then open it to join.');
  }
  await startSession(req, user);
  await audit(user.id, null, 'user.signin', 'Signed in with Google');
  let to = o.next && o.next !== '/' ? o.next : '/';
  if (inv) to = await invites.accept(inv, user, { counted: created });
  if (created) { req.flash('ok', 'Welcome to CTENT, ' + user.name.split(' ')[0] + '! Add your expertise on your profile so leaders can match you to the right parts.'); }
  res.redirect(to);
});

// ---------- Log in with Telegram ----------
r.get('/auth/telegram', (req, res) => {
  if (!telegram.configured()) return auth.notFound(res);
  req.session.tg = { next: safeNext(req.query.next), invite: String(req.query.invite || '').slice(0, 64) || null, link: !!(req.query.link && req.user), at: Date.now() };
  req.session.save(() => res.redirect(telegram.authUrl(req)));
});

// Telegram sends the person back with their signed details after "#tgAuthResult=" — only the browser
// can read that part, so this page hands it to the server in a normal form post.
r.get('/auth/telegram/callback', (req, res) => {
  if (!telegram.configured()) return auth.notFound(res);
  res.render('pages/telegram-callback', { title: 'Signing in with Telegram' });
});

r.post('/auth/telegram/verify', async (req, res) => {
  const o = req.session.tg || {};
  req.session.tg = null;
  if (!telegram.configured()) return auth.notFound(res);
  if (!o.at || Date.now() - o.at > 15 * 60000) return loginError(req, res, 'That Telegram sign-in expired. Try again.');
  let tg;
  try { tg = telegram.verify(JSON.parse(String(req.body.data || 'null'))); } catch (e) { return loginError(req, res, e instanceof SyntaxError ? 'Telegram sign-in was cancelled.' : e.message); }
  // Connecting Telegram to the signed-in account (Profile › Ways to sign in).
  if (o.link && req.user) {
    const other = await db('users').where({ telegram_id: tg.id }).whereNot('id', req.user.id).first();
    if (other) { req.flash('error', 'That Telegram account is already used by another CTENT account.'); return res.redirect('/profile#signin'); }
    await db('users').where({ id: req.user.id }).update({ telegram_id: tg.id, telegram_username: tg.username });
    await audit(req.user.id, null, 'user.signin_method', 'Connected Telegram' + (tg.username ? ' (@' + tg.username + ')' : ''));
    req.flash('ok', 'Telegram connected. You can now sign in with it.');
    return res.redirect('/profile#signin');
  }
  const user = await db('users').where({ telegram_id: tg.id }).first();
  if (user) {
    if (auth.demoBlocked(user)) return loginError(req, res, 'Demo accounts are turned off. Sign in with your own account.');
    if (user.status === 'pending') return waiting(res, user);
    if (user.status !== 'active') return loginError(req, res, 'This account is suspended. Contact your administrator.');
    if (tg.username !== user.telegram_username) await db('users').where({ id: user.id }).update({ telegram_username: tg.username });
    await startSession(req, user);
    await audit(user.id, null, 'user.signin', 'Signed in with Telegram');
    const inv = o.invite ? await invites.find(o.invite) : null;
    return res.redirect(inv ? await invites.accept(inv, user) : (o.next || '/'));
  }
  const inv = o.invite ? await invites.find(o.invite) : null;
  if (!inv && !signupOpen()) return loginError(req, res, 'No CTENT account uses this Telegram account yet. Open your invite link to join, or sign in another way and connect Telegram in your profile.');
  req.session.tgNew = { ...tg, invite: inv ? inv.token : null, at: Date.now() };
  req.session.save(() => res.redirect('/join/telegram'));
});

// First time with Telegram: check the name and (optionally) add an email.
const tgPending = (req) => { const t = req.session.tgNew; return t && Date.now() - t.at < 30 * 60000 ? t : null; };
r.get('/join/telegram', async (req, res) => {
  const t = tgPending(req);
  if (!t) return res.redirect('/login');
  res.render('pages/join-telegram', { title: 'Almost there', t, error: null, v: { name: t.name, email: '' } });
});
r.post('/join/telegram', async (req, res) => {
  const t = tgPending(req);
  if (!t) return res.redirect('/login');
  const inv = t.invite ? await invites.find(t.invite) : null;
  if (!inv && !signupOpen()) { req.session.tgNew = null; return loginError(req, res, 'That invite link no longer works. Ask for a new one.'); }
  const v = { name: String(req.body.name || '').trim().slice(0, 120), email: String(req.body.email || '').trim().toLowerCase().slice(0, 190) };
  let error = null;
  if (v.name.length < 2) error = 'Enter your name.';
  else if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) error = 'That email doesn’t look right — fix it or leave it empty.';
  else if (v.email && (await db('users').whereRaw('lower(email) = ?', [v.email]).first())) error = 'There’s already an account with that email. Sign in to it, then connect Telegram from your profile.';
  else if (await db('users').where({ telegram_id: t.id }).first()) error = 'This Telegram account already has a CTENT account. Sign in with Telegram.';
  if (error) return res.status(400).render('pages/join-telegram', { title: 'Almost there', t, error, v });
  const id = await db.insertId('users', { name: v.name, email: v.email || telegram.placeholderEmail(t.id), email_verified: false, telegram_id: t.id, telegram_username: t.username, has_password: false,
    password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10), platform_role: inv ? invites.platformRole(inv) : 'member',
    color: COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)], created_at: now() });
  req.session.tgNew = null;
  const user = await db('users').where({ id }).first();
  await audit(id, inv ? inv.topic_id : null, 'user.joined', v.name + (t.username ? ' (@' + t.username + ')' : '') + ' joined with Telegram' + (inv ? ' from an invite link' : ''));
  if (inv) await db('invites').where({ id: inv.id }).increment('uses', 1);
  if ((await approvals.onSignup(user, inv, inv ? 'Telegram · invite link' : 'Telegram · open sign-up')).pending) return waiting(res, user);
  await startSession(req, user);
  const to = inv ? await invites.accept(inv, user, { counted: true }) : '/';
  req.flash('ok', 'Welcome to CTENT, ' + v.name.split(' ')[0] + '!');
  res.redirect(to);
});

// ---------- Invite links ----------
r.get('/join/:token', async (req, res) => {
  const inv = await invites.find(req.params.token);
  if (!inv) return res.status(404).render('pages/join', { title: 'Invite link', inv: null, googleOn: google.configured(), tgOn: telegram.configured(), error: null, v: {} });
  if (req.user) {
    const to = await invites.accept(inv, req.user);
    req.flash('ok', inv.topic_id ? 'You’ve joined ' + inv.topic_code + '.' : 'You’re already in the workspace.');
    return res.redirect(to);
  }
  res.render('pages/join', { title: inv.topic_id ? 'Join ' + inv.topic_code : 'Join CTENT', inv, googleOn: google.configured(), tgOn: telegram.configured(), error: null, v: {} });
});

// Without Google: make an account with a password from the invite page.
r.post('/join/:token', async (req, res) => {
  const inv = await invites.find(req.params.token);
  if (!inv) return res.redirect('/join/' + encodeURIComponent(req.params.token));
  const v = { name: String(req.body.name || '').trim().slice(0, 120), email: String(req.body.email || '').trim().toLowerCase().slice(0, 190) };
  const pw = String(req.body.password || '');
  let error = null;
  if (v.name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) error = 'Enter your name and a valid email.';
  else if (pw.length < 10) error = 'Use a password of at least 10 characters.';
  else if (await db('users').whereRaw('lower(email) = ?', [v.email]).first()) error = 'There’s already an account with that email. Sign in first, then open the invite link again.';
  if (error) return res.status(400).render('pages/join', { title: 'Join', inv, googleOn: google.configured(), tgOn: telegram.configured(), error, v });
  const id = await db.insertId('users', { ...v, password_hash: bcrypt.hashSync(pw, 12), platform_role: invites.platformRole(inv), color: COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)], created_at: now() });
  const user = await db('users').where({ id }).first();
  await audit(id, inv.topic_id, 'user.joined', v.name + ' (' + v.email + ') joined from an invite link');
  await db('invites').where({ id: inv.id }).increment('uses', 1);
  if ((await approvals.onSignup(user, inv, 'Password · invite link')).pending) return waiting(res, user);
  await startSession(req, user);
  const to = await invites.accept(inv, user, { counted: true });
  req.flash('ok', 'Welcome to CTENT, ' + v.name.split(' ')[0] + '!');
  res.redirect(to);
});

module.exports = r;
