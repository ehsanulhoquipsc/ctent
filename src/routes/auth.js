'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../lib/auth');
const { audit } = require('../lib/events');
const { now, COLOR_NAMES } = require('../lib/util');
const google = require('../lib/google');
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

r.get('/privacy', (req, res) => res.render('pages/privacy', { title: 'Privacy policy', contact: process.env.CONTACT_EMAIL || '' }));

r.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const count = Number((await db('users').count({ n: '*' }).first()).n);
  if (count === 0) return res.redirect('/setup');
  const demo = demoLogins() ? await db('users').where('email', 'like', '%@ctent.demo').where({ status: 'active' }).orderBy('id').select('id', 'name', 'email', 'platform_role', 'title') : [];
  res.render('pages/login', { title: 'Sign in', next: safeNext(req.query.next), error: req.session.loginError || null, email: '', demo, googleOn: google.configured() });
  req.session.loginError = null;
});

r.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = req.ip + '|' + email;
  const demo = demoLogins() ? await db('users').where('email', 'like', '%@ctent.demo').where({ status: 'active' }).orderBy('id').select('id', 'name', 'email', 'platform_role', 'title') : [];
  const fail = (msg) => res.status(401).render('pages/login', { title: 'Sign in', next: safeNext(req.body.next), error: msg, email, demo, googleOn: google.configured() });
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
  req.session.oauth = { state, next: safeNext(req.query.next), invite: String(req.query.invite || '').slice(0, 64) || null, at: Date.now() };
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
  const inv = o.invite ? await invites.find(o.invite) : null;
  let user = await db('users').where({ google_sub: g.sub }).first() || await db('users').whereRaw('lower(email) = ?', [g.email]).first();
  let created = false;
  if (user && auth.demoBlocked(user)) return loginError(req, res, 'Demo accounts are turned off. Sign in with your own account.');
  if (user) {
    if (!user.google_sub) await db('users').where({ id: user.id }).update({ google_sub: g.sub });
    if (user.status === 'pending') return waiting(res, user);
    if (user.status !== 'active') return loginError(req, res, 'This account is suspended. Contact your administrator.');
  } else if (inv || signupOpen()) {
    const role = inv ? invites.platformRole(inv) : 'member';
    const id = await db.insertId('users', { name: g.name.slice(0, 120), email: g.email, google_sub: g.sub, password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
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

// ---------- Invite links ----------
r.get('/join/:token', async (req, res) => {
  const inv = await invites.find(req.params.token);
  if (!inv) return res.status(404).render('pages/join', { title: 'Invite link', inv: null, googleOn: google.configured(), error: null, v: {} });
  if (req.user) {
    const to = await invites.accept(inv, req.user);
    req.flash('ok', inv.topic_id ? 'You’ve joined ' + inv.topic_code + '.' : 'You’re already in the workspace.');
    return res.redirect(to);
  }
  res.render('pages/join', { title: inv.topic_id ? 'Join ' + inv.topic_code : 'Join CTENT', inv, googleOn: google.configured(), error: null, v: {} });
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
  if (error) return res.status(400).render('pages/join', { title: 'Join', inv, googleOn: google.configured(), error, v });
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
