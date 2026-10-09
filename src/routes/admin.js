'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../lib/auth');
const { audit, notify } = require('../lib/events');
const { now, COLOR_NAMES } = require('../lib/util');

const r = express.Router();
r.use('/admin', auth.requireRole('admin'));
const clean = (v, max) => String(v || '').trim().slice(0, max || 160);
const tempPassword = () => crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) + '7!';

r.get('/admin', async (req, res) => {
  const q = clean(req.query.q, 100).toLowerCase();
  let uq = db('users').orderBy('id');
  if (q) uq = uq.where((w) => w.whereRaw('lower(name) like ?', ['%' + q + '%']).orWhereRaw('lower(email) like ?', ['%' + q + '%']));
  const users = await uq;
  const tc = await db('topic_members').groupBy('user_id').select('user_id').count({ n: '*' });
  const topicsOf = Object.fromEntries(tc.map((x) => [x.user_id, Number(x.n)]));
  const stats = {
    users: Number((await db('users').count({ n: '*' }).first()).n),
    active: Number((await db('users').where({ status: 'active' }).count({ n: '*' }).first()).n),
    topics: Number((await db('topics').count({ n: '*' }).first()).n),
    archived: Number((await db('topics').where({ status: 'archived' }).count({ n: '*' }).first()).n),
    files: Number((await db('files').sum({ s: 'size' }).first()).s) || 0,
    messages: Number((await db('messages').count({ n: '*' }).first()).n)
  };
  const log = await db('audit_log').leftJoin('users', 'users.id', 'audit_log.user_id').leftJoin('topics', 'topics.id', 'audit_log.topic_id').orderBy('audit_log.id', 'desc').limit(40).select('audit_log.*', 'users.name', 'topics.code');
  res.render('pages/admin', { title: 'Admin console', active: 'admin', users, topicsOf, stats, log, q, created: req.session.newUser || null, colors: COLOR_NAMES });
  req.session.newUser = null;
});
r.post('/admin/users', async (req, res) => {
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 190).toLowerCase();
  const role = ['admin', 'leader', 'member', 'guest'].includes(req.body.role) ? req.body.role : 'member';
  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { req.flash('error', 'Enter a name and a valid email.'); return res.redirect('/admin#users'); }
  if (await db('users').whereRaw('lower(email) = ?', [email]).first()) { req.flash('error', 'Someone with that email already has an account.'); return res.redirect('/admin#users'); }
  const pw = tempPassword();
  const id = await db.insertId('users', { name, email, password_hash: bcrypt.hashSync(pw, 12), platform_role: role, institution: clean(req.body.institution), title: clean(req.body.title), color: COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)], created_at: now() });
  await notify(id, { kind: 'access', title: 'Welcome to CTENT, ' + name.split(' ')[0], body: 'Add your expertise so leaders can match you to the right parts.', link: '/profile' });
  await audit(req.user.id, null, 'user.created', 'Created ' + role + ' account for ' + name + ' (' + email + ')');
  req.session.newUser = { name, email, password: pw };
  res.redirect('/admin#users');
});
r.post('/admin/users/:id', async (req, res) => {
  const u = await db('users').where({ id: parseInt(req.params.id, 10) }).first();
  if (!u) return auth.notFound(res);
  const action = req.body.action;
  if (u.id === req.user.id && action !== 'reset') { req.flash('error', 'You can’t change your own role or suspend yourself.'); return res.redirect('/admin#users'); }
  if (action === 'role') {
    const role = ['admin', 'leader', 'member', 'guest'].includes(req.body.role) ? req.body.role : u.platform_role;
    await db('users').where({ id: u.id }).update({ platform_role: role });
    if (role === 'guest') await db('topic_members').where({ user_id: u.id }).update({ role: 'guest' });
    await audit(req.user.id, null, 'user.role', 'Set ' + u.name + '’s platform role to ' + role);
    req.flash('ok', u.name + ' is now ' + role + '.');
  } else if (action === 'status') {
    const status = u.status === 'active' ? 'suspended' : 'active';
    await db('users').where({ id: u.id }).update({ status });
    if (status === 'suspended') await auth.killSessions(u.id);
    await audit(req.user.id, null, 'user.' + status, (status === 'active' ? 'Restored ' : 'Suspended ') + u.name);
    req.flash('ok', u.name + (status === 'active' ? ' restored.' : ' suspended and signed out.'));
  } else if (action === 'reset') {
    const pw = tempPassword();
    await db('users').where({ id: u.id }).update({ password_hash: bcrypt.hashSync(pw, 12) });
    await auth.killSessions(u.id, req.sessionID);
    await audit(req.user.id, null, 'user.reset', 'Reset password for ' + u.name);
    req.session.newUser = { name: u.name, email: u.email, password: pw, reset: true };
  }
  res.redirect('/admin#users');
});

module.exports = r;
