'use strict';
// Invite links: share a project (or the whole workspace) with anyone, then they sign in with Google.
const crypto = require('crypto');
const db = require('../db');
const { now } = require('./util');
const { notify, audit } = require('./events');

const DAY = 86400000;

async function create(by, { topicId = null, role = 'member', days = 14, maxUses = null } = {}) {
  const token = crypto.randomBytes(18).toString('base64url');
  await db('invites').insert({ token, topic_id: topicId, role, created_by: by.id, max_uses: maxUses, expires_at: days ? new Date(Date.now() + days * DAY).toISOString() : null, created_at: now() });
  return token;
}

// A usable invite with its project (if any), or null.
async function find(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  const inv = await db('invites').leftJoin('topics', 'topics.id', 'invites.topic_id').leftJoin('users', 'users.id', 'invites.created_by')
    .where('invites.token', token).first('invites.*', 'topics.title as topic_title', 'topics.code as topic_code', 'topics.status as topic_status', 'users.name as by_name');
  if (!inv || inv.revoked_at) return null;
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return null;
  if (inv.max_uses && inv.uses >= inv.max_uses) return null;
  if (inv.topic_id && (!inv.topic_title || inv.topic_status === 'archived')) return null;
  return inv;
}

// The platform role a new account gets from this invite.
function platformRole(inv) {
  if (!inv.topic_id) return ['leader', 'member', 'guest'].includes(inv.role) ? inv.role : 'member';
  return inv.role === 'guest' ? 'guest' : inv.role === 'leader' ? 'leader' : 'member';
}

// Use the invite for this person: join the project (if any). Returns where to go next.
async function accept(inv, user) {
  await db('invites').where({ id: inv.id }).increment('uses', 1);
  if (!inv.topic_id) return '/';
  const has = await db('topic_members').where({ topic_id: inv.topic_id, user_id: user.id }).first();
  if (!has) {
    const role = user.platform_role === 'guest' ? 'guest' : inv.role;
    await db('topic_members').insert({ topic_id: inv.topic_id, user_id: user.id, role, joined_at: now() });
    await audit(user.id, inv.topic_id, 'member.joined', user.name + ' joined with an invite link as ' + role);
    const leaders = await db('topic_members').where({ topic_id: inv.topic_id, role: 'leader' }).whereNot('user_id', user.id).pluck('user_id');
    for (const id of leaders) await notify(id, { kind: 'access', title: user.name + ' joined ' + inv.topic_code + ' with your invite link', body: inv.topic_title, link: '/topics/' + inv.topic_id + '/members' }, user.id);
  }
  return '/topics/' + inv.topic_id;
}

const linkOf = (req, token) => (process.env.APP_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '') + '/join/' + token;

module.exports = { create, find, accept, platformRole, linkOf };
