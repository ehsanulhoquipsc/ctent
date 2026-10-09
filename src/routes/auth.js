'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../lib/auth');
const { audit } = require('../lib/events');
const { now } = require('../lib/util');

const r = express.Router();
const demoLogins = () => process.env.DEMO_LOGINS !== 'false';
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

async function startSession(req, user) {
  await new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
  req.session.uid = user.id;
  await db('users').where({ id: user.id }).update({ last_login_at: now() });
}

r.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const count = Number((await db('users').count({ n: '*' }).first()).n);
  if (count === 0) return res.redirect('/setup');
  const demo = demoLogins() ? await db('users').where('email', 'like', '%@ctent.demo').where({ status: 'active' }).orderBy('id').select('id', 'name', 'email', 'platform_role', 'title') : [];
  res.render('pages/login', { title: 'Sign in', next: safeNext(req.query.next), error: null, email: '', demo });
});

r.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = req.ip + '|' + email;
  const demo = demoLogins() ? await db('users').where('email', 'like', '%@ctent.demo').where({ status: 'active' }).orderBy('id').select('id', 'name', 'email', 'platform_role', 'title') : [];
  const fail = (msg) => res.status(401).render('pages/login', { title: 'Sign in', next: safeNext(req.body.next), error: msg, email, demo });
  if (auth.tooManyAttempts(key)) return fail('Too many attempts. Wait 15 minutes and try again.');
  const user = await db('users').whereRaw('lower(email) = ?', [email]).first();
  if (!user || !bcrypt.compareSync(password, user.password_hash)) { auth.recordFailure(key); return fail('That email and password don’t match.'); }
  if (user.status !== 'active') return fail('This account is suspended. Contact your administrator.');
  auth.clearFailures(key);
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

module.exports = r;
