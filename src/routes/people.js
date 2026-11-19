'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../lib/auth');
const { audit } = require('../lib/events');
const { COLOR_NAMES } = require('../lib/util');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 160);

r.get('/people/:id', async (req, res) => {
  const p = await db('users').where({ id: parseInt(req.params.id, 10) }).first();
  if (!p) return auth.notFound(res);
  const expertise = await db('expertise').where({ user_id: p.id }).orderBy('level', 'desc');
  const mine = await auth.myTopicIds(req.user);
  const shared = mine.length ? await db('topic_members').join('topics', 'topics.id', 'topic_members.topic_id').where('topic_members.user_id', p.id).whereIn('topics.id', mine).select('topics.id', 'topics.code', 'topics.title', 'topics.color', 'topic_members.role') : [];
  const open = await db('tasks').where({ assignee_id: p.id }).whereNot('status', 'done').count({ n: '*' }).first();
  const done = await db('tasks').where({ assignee_id: p.id, status: 'done' }).count({ n: '*' }).first();
  const canSeeContact = req.user.id === p.id || req.user.platform_role === 'admin' || shared.length > 0;
  res.render('pages/person', { title: p.name, active: '', p, expertise, shared, open: Number(open.n), done: Number(done.n), canSeeContact });
});

r.get('/profile', async (req, res) => {
  const expertise = await db('expertise').where({ user_id: req.user.id }).orderBy('kind').orderBy('level', 'desc');
  res.render('pages/profile', { title: 'Profile & expertise', active: 'profile', expertise, colors: COLOR_NAMES, googleOn: require('../lib/google').configured(), tgOn: require('../lib/telegram').configured() });
});
r.post('/profile', async (req, res) => {
  const name = clean(req.body.name, 120);
  if (name.length < 2) { req.flash('error', 'Enter your name.'); return res.redirect('/profile'); }
  await db('users').where({ id: req.user.id }).update({ name, title: clean(req.body.title), institution: clean(req.body.institution), color: COLOR_NAMES.includes(req.body.color) ? req.body.color : req.user.color, weekly_hours: Math.max(0, Math.min(60, parseInt(req.body.weekly_hours, 10) || 0)) });
  req.flash('ok', 'Profile saved.');
  res.redirect('/profile');
});
r.post('/profile/expertise', async (req, res) => {
  const name = clean(req.body.name, 120);
  if (!name) { req.flash('error', 'Type a field, method, region or language.'); return res.redirect('/profile'); }
  const kind = ['field', 'method', 'region', 'language'].includes(req.body.kind) ? req.body.kind : 'field';
  const level = Math.max(1, Math.min(5, parseInt(req.body.level, 10) || 3));
  const exists = await db('expertise').where({ user_id: req.user.id }).whereRaw('lower(name) = ?', [name.toLowerCase()]).first();
  if (exists) await db('expertise').where({ id: exists.id }).update({ level, kind });
  else await db('expertise').insert({ user_id: req.user.id, kind, name, level });
  req.flash('ok', name + ' saved at level ' + level + '.');
  res.redirect('/profile#expertise');
});
r.post('/profile/expertise/:id', async (req, res) => {
  const e = await db('expertise').where({ id: parseInt(req.params.id, 10), user_id: req.user.id }).first();
  if (!e) return auth.notFound(res);
  const name = clean(req.body.name, 120) || e.name;
  const kind = ['field', 'method', 'region', 'language'].includes(req.body.kind) ? req.body.kind : e.kind;
  const level = Math.max(1, Math.min(5, parseInt(req.body.level, 10) || e.level));
  await db('expertise').where({ id: e.id }).update({ name, kind, level });
  req.flash('ok', name + ' updated.');
  res.redirect('/profile#expertise');
});
r.post('/profile/expertise/:id/delete', async (req, res) => {
  await db('expertise').where({ id: parseInt(req.params.id, 10), user_id: req.user.id }).del();
  res.redirect('/profile#expertise');
});
r.post('/profile/password', async (req, res) => {
  const u = await db('users').where({ id: req.user.id }).first();
  // Accounts made with Google or Telegram have no password yet: they can set one without the old one.
  if (u.has_password && !bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) { req.flash('error', 'Your current password is wrong.'); return res.redirect('/profile#password'); }
  if (!u.has_password && require('../lib/telegram').isPlaceholder(u.email)) { req.flash('error', 'Add your email first — you’ll sign in with your email and password.'); return res.redirect('/profile#signin'); }
  const pw = String(req.body.password || '');
  if (pw.length < 10) { req.flash('error', 'Use at least 10 characters for the new password.'); return res.redirect('/profile#password'); }
  if (pw !== req.body.password2) { req.flash('error', 'The new passwords don’t match.'); return res.redirect('/profile#password'); }
  await db('users').where({ id: u.id }).update({ password_hash: bcrypt.hashSync(pw, 12), has_password: true });
  await auth.killSessions(u.id, req.sessionID);
  await audit(u.id, null, 'user.password', u.has_password ? 'Changed their password' : 'Set a password');
  req.flash('ok', u.has_password ? 'Password changed. Other devices were signed out.' : 'Password set. You can now sign in with your email and password too.');
  res.redirect('/profile');
});

// Ways to sign in: remove Google or Telegram (only while another way remains), add an email.
const methodsOf = (u) => (u.google_sub ? 1 : 0) + (u.telegram_id ? 1 : 0) + (u.has_password ? 1 : 0);
r.post('/profile/:m/remove', async (req, res, next) => {
  const m = req.params.m;
  if (m !== 'google' && m !== 'telegram') return next();
  const u = await db('users').where({ id: req.user.id }).first();
  if (methodsOf(u) < 2) { req.flash('error', 'Keep at least one way to sign in.'); return res.redirect('/profile#signin'); }
  await db('users').where({ id: u.id }).update(m === 'google' ? { google_sub: null } : { telegram_id: null, telegram_username: null });
  await audit(u.id, null, 'user.signin_method', 'Removed ' + (m === 'google' ? 'Google' : 'Telegram') + ' sign-in');
  req.flash('ok', (m === 'google' ? 'Google' : 'Telegram') + ' sign-in removed.');
  res.redirect('/profile#signin');
});
r.post('/profile/email', async (req, res) => {
  const u = await db('users').where({ id: req.user.id }).first();
  if (!require('../lib/telegram').isPlaceholder(u.email)) return res.redirect('/profile#signin');
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { req.flash('error', 'That email doesn’t look right.'); return res.redirect('/profile#signin'); }
  if (await db('users').whereRaw('lower(email) = ?', [email]).first()) { req.flash('error', 'Another account already uses that email.'); return res.redirect('/profile#signin'); }
  await db('users').where({ id: u.id }).update({ email, email_verified: false });
  await audit(u.id, null, 'user.email', 'Added an email address');
  req.flash('ok', 'Email saved.');
  res.redirect('/profile#signin');
});

module.exports = r;
