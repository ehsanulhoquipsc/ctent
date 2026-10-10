'use strict';
// Meeting rooms: every topic gets a project room for the whole team automatically; people can add team rooms.
const crypto = require('crypto');
const db = require('../db');
const { now, detectPlatform } = require('./util');

// A free video room that works instantly with no account (can be swapped for Zoom/Meet/Teams later).
function autoLink(code, name) {
  const slug = (String(code || 'CTENT') + '-' + String(name || 'room')).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return 'https://meet.jit.si/CTENT-' + slug + '-' + crypto.randomBytes(4).toString('hex');
}

async function ensureProjectRoom(topic, userId) {
  const room = await db('meeting_rooms').where({ topic_id: topic.id, kind: 'project' }).first();
  if (room) return room;
  const ch = await db('channels').where({ topic_id: topic.id }).orderBy('id').first();
  const link = autoLink(topic.code, 'project');
  const id = await db.insertId('meeting_rooms', { topic_id: topic.id, name: topic.title.slice(0, 80), kind: 'project', purpose: 'Everyone in ' + topic.code, link, platform: detectPlatform(link), channel_id: ch ? ch.id : null, created_by: userId || topic.created_by || null, created_at: now() });
  return db('meeting_rooms').where({ id }).first();
}

// Rooms this person can see in a topic, with their members. Leaders see every room.
async function roomsFor(topic, user, role) {
  await ensureProjectRoom(topic, user.id);
  const all = await db('meeting_rooms').leftJoin('parts', 'parts.id', 'meeting_rooms.part_id').leftJoin('tasks', 'tasks.id', 'meeting_rooms.task_id')
    .where('meeting_rooms.topic_id', topic.id).orderByRaw("case meeting_rooms.kind when 'project' then 0 else 1 end").orderBy('meeting_rooms.id')
    .select('meeting_rooms.*', 'parts.title as part_title', 'tasks.title as task_title');
  const ids = all.map((r) => r.id);
  const rm = ids.length ? await db('meeting_room_members').join('users', 'users.id', 'meeting_room_members.user_id').whereIn('room_id', ids).orderBy('users.name').select('room_id', 'users.id', 'users.name', 'users.color') : [];
  const team = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', topic.id).whereNot('topic_members.role', 'guest').orderBy('users.name').select('users.id', 'users.name', 'users.color');
  return all.map((r) => ({ ...r, people: r.kind === 'project' ? team : rm.filter((x) => x.room_id === r.id) }))
    .filter((r) => r.kind === 'project' || role === 'leader' || r.created_by === user.id || r.people.some((p) => p.id === user.id));
}

module.exports = { autoLink, ensureProjectRoom, roomsFor };
