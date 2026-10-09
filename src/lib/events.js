'use strict';
const db = require('../db');
const { now } = require('./util');

// Send an in-app notification to one or more users (skipping the person who caused it).
async function notify(userIds, { kind, title, body, link }, exceptUserId) {
  const ids = [...new Set([].concat(userIds || []).filter((id) => id && id !== exceptUserId))];
  if (!ids.length) return;
  await db('notifications').insert(ids.map((user_id) => ({ user_id, kind, title, body: body || null, link: link || null, created_at: now() })));
}

// Append-only activity record, shown per topic and in the admin audit log.
async function audit(userId, topicId, action, detail) {
  await db('audit_log').insert({ user_id: userId || null, topic_id: topicId || null, action, detail: detail || null, created_at: now() });
}

async function topicLeaders(topicId) {
  const rows = await db('topic_members').where({ topic_id: topicId, role: 'leader' }).select('user_id');
  return rows.map((r) => r.user_id);
}

module.exports = { notify, audit, topicLeaders };
