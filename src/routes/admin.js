'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../lib/auth');
const { audit, notify } = require('../lib/events');
const { now, COLOR_NAMES } = require('../lib/util');
const { wipeContent } = require('../lib/wipe');
const invites = require('../lib/invites');
const approvals = require('../lib/approvals');

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
  const invs = (await db('invites').whereNull('topic_id').whereNull('revoked_at').orderBy('id', 'desc')).filter((i) => !i.expires_at || new Date(i.expires_at).getTime() > Date.now()).map((i) => ({ ...i, link: invites.linkOf(req, i.token) }));
  const pending = await db('users').leftJoin('topics', 'topics.id', 'users.pending_topic_id').where('users.status', 'pending').orderBy('users.id')
    .select('users.*', 'topics.code as topic_code', 'topics.title as topic_title');
  res.render('pages/admin', { title: 'Admin console', active: 'admin', users: users.filter((x) => x.status !== 'pending'), pending, approvalOn: approvals.required(), topicsOf, stats, log, q, created: req.session.newUser || null, colors: COLOR_NAMES, invs, googleOn: require('../lib/google').configured() });
  req.session.newUser = null;
});
r.post('/admin/invites', async (req, res) => {
  if (req.body.action === 'revoke') {
    await db('invites').where({ id: parseInt(req.body.id, 10) }).whereNull('topic_id').update({ revoked_at: now() });
    req.flash('ok', 'That invite link no longer works.');
  } else {
    const role = ['leader', 'member', 'guest'].includes(req.body.role) ? req.body.role : 'member';
    await invites.create(req.user, { role, days: 14 });
    await audit(req.user.id, null, 'invite.created', 'Made a workspace invite link (' + role + ')');
    req.flash('ok', 'Invite link ready — copy it and send it.');
  }
  res.redirect('/admin#invite');
});
// New accounts waiting for an admin
r.post('/admin/approvals/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.body.action === 'decline') {
    const u = await approvals.decline(req.user, id);
    req.flash(u ? 'ok' : 'error', u ? u.name + '’s request was declined and removed.' : 'That request was already handled.');
  } else {
    const u = await approvals.approve(req.user, id, req.body.role);
    req.flash(u ? 'ok' : 'error', u ? u.name + ' is approved. They can sign in now.' : 'That request was already handled.');
  }
  res.redirect('/admin#approvals');
});

// One person's activity: sign-ins, what they did, where they work
r.get('/admin/users/:id/activity', async (req, res) => {
  const p = await db('users').where({ id: parseInt(req.params.id, 10) }).first();
  if (!p) return auth.notFound(res);
  const log = await db('audit_log').leftJoin('topics', 'topics.id', 'audit_log.topic_id').where('audit_log.user_id', p.id).orderBy('audit_log.id', 'desc').limit(200)
    .select('audit_log.*', 'topics.code', 'topics.title as topic_title');
  const projects = await db('topic_members').join('topics', 'topics.id', 'topic_members.topic_id').where('topic_members.user_id', p.id).orderBy('topics.id', 'desc')
    .select('topics.id', 'topics.code', 'topics.title', 'topics.status', 'topic_members.role', 'topic_members.joined_at');
  const count = async (q) => Number((await q.count({ n: '*' }).first()).n);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const totals = {
    signins: await count(db('audit_log').where({ user_id: p.id, action: 'user.signin' }).where('created_at', '>=', since)),
    messages: await count(db('messages').where({ user_id: p.id })),
    tasks: await count(db('tasks').where({ assignee_id: p.id })),
    tasksDone: await count(db('tasks').where({ assignee_id: p.id, status: 'done' })),
    files: await count(db('files').where({ uploaded_by: p.id })),
    actions: await count(db('audit_log').where({ user_id: p.id }).whereNot('action', 'user.signin'))
  };
  const approver = p.approved_by ? await db('users').where({ id: p.approved_by }).first('name') : null;
  res.render('pages/admin-activity', { title: 'Activity · ' + p.name, active: 'admin', crumb: '<a href="/admin">Admin console</a> / Activity', person: p, log, projects, totals, approver });
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
  if (action === 'edit') {
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 190).toLowerCase();
    if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { req.flash('error', 'Enter a name and a valid email.'); return res.redirect('/admin#users'); }
    if (await db('users').whereRaw('lower(email) = ?', [email]).whereNot('id', u.id).first()) { req.flash('error', 'Someone else already uses that email.'); return res.redirect('/admin#users'); }
    await db('users').where({ id: u.id }).update({ name, email, institution: clean(req.body.institution), title: clean(req.body.title) });
    await audit(req.user.id, null, 'user.edited', 'Edited details for ' + name + (email !== u.email ? ' (email changed)' : ''));
    req.flash('ok', name + '’s details saved.');
    return res.redirect('/admin#users');
  }
  if (action === 'delete') {
    if (u.id === req.user.id) { req.flash('error', 'You can’t delete your own account.'); return res.redirect('/admin#users'); }
    // Don't leave a topic without a leader.
    const led = await db('topic_members').join('topics', 'topics.id', 'topic_members.topic_id').where({ 'topic_members.user_id': u.id, 'topic_members.role': 'leader' }).select('topics.id', 'topics.code');
    const orphans = [];
    for (const t of led) {
      const others = await db('topic_members').where({ topic_id: t.id, role: 'leader' }).whereNot('user_id', u.id).count({ n: '*' }).first();
      if (!Number(others.n)) orphans.push(t.code);
    }
    if (orphans.length) { req.flash('error', u.name + ' is the only leader of ' + orphans.join(', ') + '. Make someone else a leader there first, or suspend the account instead.'); return res.redirect('/admin#users'); }
    if (String(req.body.confirm || '').trim().toLowerCase() !== u.email.toLowerCase()) { req.flash('error', 'Type the person’s email to confirm deleting their account.'); return res.redirect('/admin#users'); }
    await auth.killSessions(u.id);
    await db('users').where({ id: u.id }).del();
    await audit(req.user.id, null, 'user.deleted', 'Deleted the account of ' + u.name + ' (' + u.email + ')');
    req.flash('ok', u.name + '’s account was deleted. Their past messages and work stay, shown as “Former member”.');
    return res.redirect('/admin#users');
  }
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

// Danger zone: clear every topic, message, file and notification. Accounts stay.
r.post('/admin/clear-content', async (req, res) => {
  if (String(req.body.confirm || '').trim() !== 'CLEAR') { req.flash('error', 'Type CLEAR to confirm.'); return res.redirect('/admin#danger'); }
  await wipeContent(db);
  await audit(req.user.id, null, 'workspace.cleared', 'Cleared all workspace data (accounts kept)');
  req.flash('ok', 'All workspace data was cleared. User accounts were kept.');
  res.redirect('/admin');
});

module.exports = r;
