'use strict';
const crypto = require('crypto');
const db = require('../db');

const RANK = { guest: 0, member: 1, leader: 2, admin: 3 };

// ---------- CSRF ----------
function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function csrfOk(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const real = req.session && req.session.csrf;
  if (!real || !sent || sent.length !== real.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real));
}
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if ((req.get('content-type') || '').startsWith('multipart/form-data')) return next(); // checked after upload parsing
  if (!csrfOk(req)) return res.status(403).render('pages/error', { title: 'Session expired', code: 403, message: 'Your form expired. Go back, refresh the page and try again.' });
  next();
}
function csrfAfterUpload(req, res, next) {
  if (!csrfOk(req)) return res.status(403).render('pages/error', { title: 'Session expired', code: 403, message: 'Your form expired. Go back, refresh the page and try again.' });
  next();
}

// ---------- Login rate limit (per IP + email) ----------
const attempts = new Map();
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(key); return false; }
  return a.count >= 8;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}
function clearFailures(key) { attempts.delete(key); }

// ---------- Users ----------
async function loadUser(req, res, next) {
  res.locals.me = null;
  if (req.session && req.session.uid) {
    const u = await db('users').where({ id: req.session.uid }).first();
    if (u && u.status === 'active') {
      req.user = u;
      res.locals.me = u;
    } else {
      req.session.uid = null;
    }
  }
  next();
}
function requireUser(req, res, next) {
  if (!req.user) {
    if (req.accepts(['html', 'json']) === 'json' || req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}
const atLeast = (user, role) => !!user && RANK[user.platform_role] >= RANK[role];
function requireRole(role) {
  return (req, res, next) => (atLeast(req.user, role) ? next() : forbidden(res, 'This page needs ' + role + ' access.'));
}
function forbidden(res, message) {
  return res.status(403).render('pages/error', { title: 'No access', code: 403, message: message || 'You don’t have access to this.' });
}
function notFound(res, message) {
  return res.status(404).render('pages/error', { title: 'Not found', code: 404, message: message || 'We can’t find that page. The link may be old, or it was moved.' });
}

// ---------- Topic access ----------
// Admins see every topic. Everyone else sees only topics they belong to.
async function topicAccess(user, topicId) {
  const topic = await db('topics').where({ id: topicId }).first();
  if (!topic) return { topic: null, role: null };
  if (user.platform_role === 'admin') return { topic, role: 'leader', isAdmin: true };
  const m = await db('topic_members').where({ topic_id: topicId, user_id: user.id }).first();
  return { topic, role: m ? m.role : null };
}
function loadTopic(minRole) {
  return async (req, res, next) => {
    const tid = parseInt(req.params.tid, 10);
    if (!tid) return notFound(res);
    const { topic, role } = await topicAccess(req.user, tid);
    if (!topic) return notFound(res, 'That topic doesn’t exist or was deleted.');
    if (!role) return forbidden(res, 'You’re not a member of this topic. Ask the topic leader for access.');
    const need = { guest: 0, member: 1, leader: 2 }[minRole || 'guest'];
    const have = { guest: 0, member: 1, leader: 2 }[role];
    if (have < need) return forbidden(res, minRole === 'leader' ? 'Only the topic leader can do this.' : 'Guests have read-only access to this topic.');
    req.topic = topic; req.topicRole = role;
    res.locals.topic = topic; res.locals.topicRole = role;
    res.locals.isTopicLeader = role === 'leader';
    res.locals.isGuest = role === 'guest';
    res.locals.topicMembersPreview = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', topic.id).orderByRaw("case topic_members.role when 'leader' then 0 when 'member' then 1 else 2 end").limit(5).select('users.id', 'users.name', 'users.color');
    next();
  };
}
async function myTopicIds(user) {
  if (user.platform_role === 'admin') return (await db('topics').select('id')).map((r) => r.id);
  return (await db('topic_members').where({ user_id: user.id }).select('topic_id')).map((r) => r.topic_id);
}

// Sign a user out everywhere (optionally keeping the current session).
async function killSessions(uid, exceptSid) {
  let q = db('sessions').where((w) => w.where('sess', 'like', '%"uid":' + Number(uid) + ',%').orWhere('sess', 'like', '%"uid":' + Number(uid) + '}%'));
  if (exceptSid) q = q.whereNot('sid', exceptSid);
  await q.del();
}

// Topics where the user actually works (excludes topics they only see as a guest).
async function workTopicIds(user) {
  if (user.platform_role === 'admin') return (await db('topics').select('id')).map((r) => r.id);
  return (await db('topic_members').where({ user_id: user.id }).whereNot('role', 'guest').select('topic_id')).map((r) => r.topic_id);
}

module.exports = { workTopicIds, killSessions, RANK, csrfToken, csrf, csrfAfterUpload, csrfOk, tooManyAttempts, recordFailure, clearFailures, loadUser, requireUser, requireRole, atLeast, forbidden, notFound, topicAccess, loadTopic, myTopicIds };
