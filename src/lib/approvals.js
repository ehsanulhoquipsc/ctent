'use strict';
// Admin approval for new accounts. On by default; REQUIRE_APPROVAL=false lets people in straight away.
const db = require('../db');
const { now } = require('./util');
const { notify, audit } = require('./events');

const required = () => process.env.REQUIRE_APPROVAL !== 'false';

// Called right after a person creates their own account (Google, invite page, open sign-up).
// With approval on, the account waits and the project is joined only once an admin approves.
async function onSignup(user, inv, how) {
  const via = how + (inv ? (inv.by_name ? ' from ' + inv.by_name : '') + (inv.topic_code ? ' · ' + inv.topic_code : '') : '');
  if (!required()) { await db('users').where({ id: user.id }).update({ joined_via: via }); return { pending: false }; }
  await db('users').where({ id: user.id }).update({ status: 'pending', joined_via: via, pending_topic_id: inv ? inv.topic_id : null, pending_topic_role: inv && inv.topic_id ? inv.role : null });
  const admins = await db('users').where({ platform_role: 'admin', status: 'active' }).pluck('id');
  for (const id of admins) await notify(id, { kind: 'access', title: user.name + ' is waiting for approval', body: user.email + ' · ' + via, link: '/admin#approvals' }, user.id);
  return { pending: true };
}

async function approve(admin, userId, role) {
  const u = await db('users').where({ id: userId, status: 'pending' }).first();
  if (!u) return null;
  const platformRole = ['admin', 'leader', 'member', 'guest'].includes(role) ? role : u.platform_role;
  await db('users').where({ id: u.id }).update({ status: 'active', platform_role: platformRole, approved_by: admin.id, approved_at: now(), pending_topic_id: null, pending_topic_role: null });
  if (u.pending_topic_id) {
    const t = await db('topics').where({ id: u.pending_topic_id }).first();
    if (t && t.status !== 'archived' && !(await db('topic_members').where({ topic_id: t.id, user_id: u.id }).first())) {
      const r = platformRole === 'guest' ? 'guest' : (u.pending_topic_role || 'member');
      await db('topic_members').insert({ topic_id: t.id, user_id: u.id, role: r, joined_at: now() });
      const leaders = await db('topic_members').where({ topic_id: t.id, role: 'leader' }).pluck('user_id');
      for (const id of leaders) await notify(id, { kind: 'access', title: u.name + ' joined ' + t.code, body: 'Approved by ' + admin.name + ' · joined with your invite link', link: '/topics/' + t.id + '/members' }, admin.id);
    }
  }
  await notify(u.id, { kind: 'access', title: 'Welcome to CTENT, ' + u.name.split(' ')[0] + '! Your account is approved', body: 'Add your expertise on your profile so leaders can match you to the right parts.', link: u.pending_topic_id ? '/topics/' + u.pending_topic_id : '/profile' }, admin.id);
  await audit(admin.id, u.pending_topic_id || null, 'user.approved', 'Approved the account of ' + u.name + ' (' + u.email + ') as ' + platformRole);
  return u;
}

async function decline(admin, userId) {
  const u = await db('users').where({ id: userId, status: 'pending' }).first();
  if (!u) return null;
  await db('users').where({ id: u.id }).del();
  await audit(admin.id, null, 'user.declined', 'Declined the account request of ' + u.name + ' (' + u.email + ')');
  return u;
}

module.exports = { required, onSignup, approve, decline };
