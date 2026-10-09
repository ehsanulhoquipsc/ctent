'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit } = require('../lib/events');
const { now, avatar, fmtTime, fmtDate, toDate } = require('../lib/util');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);

// Channels this user can read: topic channels for topics they work in (not as guest), plus rooms they're in.
async function myChannels(user) {
  const tids = user.platform_role === 'admin'
    ? (await db('topics').whereNot('status', 'archived').select('id')).map((x) => x.id)
    : (await db('topic_members').where({ user_id: user.id }).whereNot('role', 'guest').select('topic_id')).map((x) => x.topic_id);
  const topicCh = tids.length ? await db('channels').join('topics', 'topics.id', 'channels.topic_id').whereIn('channels.topic_id', tids).orderBy('topics.id', 'desc').orderBy('channels.id').select('channels.*', 'topics.code', 'topics.color') : [];
  const rooms = await db('channels').join('channel_members', 'channel_members.channel_id', 'channels.id').where({ 'channel_members.user_id': user.id, 'channels.kind': 'room' }).orderBy('channels.id').select('channels.*');
  return { topicCh, rooms, all: [...topicCh, ...rooms] };
}
async function canRead(user, ch) {
  if (!ch) return false;
  if (ch.kind === 'room') return !!(await db('channel_members').where({ channel_id: ch.id, user_id: user.id }).first());
  if (user.platform_role === 'admin') return true;
  const m = await db('topic_members').where({ topic_id: ch.topic_id, user_id: user.id }).first();
  return !!m && m.role !== 'guest';
}
function shape(m) {
  const d = toDate(m.created_at);
  const today = d && d.toDateString() === new Date().toDateString();
  return { id: m.id, body: m.body, name: m.name || 'Former member', time: (today ? '' : fmtDate(d) + ' ') + fmtTime(d), avatar: avatar({ id: m.uid, name: m.name || '?', color: m.color }) };
}
const msgQuery = (cid) => db('messages').leftJoin('users', 'users.id', 'messages.user_id').where('messages.channel_id', cid).select('messages.*', 'users.name', 'users.color', 'users.id as uid');

r.get('/messages', async (req, res) => {
  const { all } = await myChannels(req.user);
  if (!all.length) return res.render('pages/messages', { title: 'Messages', active: 'messages', mainClass: 'chat-page', channel: null, topicCh: [], rooms: [], msgs: [], people: await db('users').where({ status: 'active' }).whereNot('id', req.user.id).orderBy('name'), last: 0, members: [] });
  res.redirect('/messages/' + all[0].id);
});
r.get('/topics/:tid/channels', auth.loadTopic('member'), async (req, res) => {
  const ch = await db('channels').where({ topic_id: req.topic.id }).orderBy('id').first();
  if (!ch) {
    const id = await db.insertId('channels', { topic_id: req.topic.id, name: 'general', kind: 'topic', created_by: req.user.id, created_at: now() });
    return res.redirect('/messages/' + id);
  }
  res.redirect('/messages/' + ch.id);
});
r.get('/messages/:cid', async (req, res) => {
  const ch = await db('channels').where({ id: parseInt(req.params.cid, 10) }).first();
  if (!(await canRead(req.user, ch))) return auth.notFound(res, 'That conversation doesn’t exist or you don’t have access.');
  const { topicCh, rooms } = await myChannels(req.user);
  const msgs = (await msgQuery(ch.id).orderBy('messages.id', 'desc').limit(100)).reverse().map(shape);
  const topic = ch.topic_id ? await db('topics').where({ id: ch.topic_id }).first() : null;
  const members = ch.kind === 'room'
    ? await db('channel_members').join('users', 'users.id', 'channel_members.user_id').where({ channel_id: ch.id }).select('users.id', 'users.name', 'users.color')
    : await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where({ topic_id: ch.topic_id }).whereNot('role', 'guest').select('users.id', 'users.name', 'users.color');
  const people = await db('users').where({ status: 'active' }).whereNot('id', req.user.id).whereNot('platform_role', 'guest').orderBy('name').select('id', 'name');
  res.render('pages/messages', { title: (ch.kind === 'room' ? '' : '#') + ch.name, active: 'messages', mainClass: 'chat-page', channel: ch, topic, topicCh, rooms, msgs, members, people, last: msgs.length ? msgs[msgs.length - 1].id : 0 });
});

// JSON API used by the live chat
r.get('/api/channels/:cid/messages', async (req, res) => {
  const ch = await db('channels').where({ id: parseInt(req.params.cid, 10) }).first();
  if (!(await canRead(req.user, ch))) return res.status(404).json({ error: 'Not found' });
  const after = parseInt(req.query.after, 10) || 0;
  const msgs = await msgQuery(ch.id).where('messages.id', '>', after).orderBy('messages.id').limit(100);
  res.json({ messages: msgs.map(shape) });
});
r.post('/api/channels/:cid/messages', async (req, res) => {
  const ch = await db('channels').where({ id: parseInt(req.params.cid, 10) }).first();
  if (!(await canRead(req.user, ch))) return res.status(404).json({ error: 'Not found' });
  if (ch.topic_id) {
    const t = await db('topics').where({ id: ch.topic_id }).first();
    if (t && t.status === 'archived') return res.status(403).json({ error: 'This topic is archived.' });
  }
  const body = clean(req.body.body, 4000);
  if (!body) return res.status(400).json({ error: 'Empty message' });
  const id = await db.insertId('messages', { channel_id: ch.id, user_id: req.user.id, body, created_at: now() });
  // @mentions notify the person by first name
  const mentioned = [...body.matchAll(/@([A-Za-z][\w-]+)/g)].map((m) => m[1].toLowerCase());
  if (mentioned.length) {
    const members = ch.kind === 'room'
      ? await db('channel_members').join('users', 'users.id', 'channel_members.user_id').where({ channel_id: ch.id }).select('users.id', 'users.name')
      : await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where({ topic_id: ch.topic_id }).select('users.id', 'users.name');
    const hit = members.filter((p) => mentioned.includes(p.name.replace(/^Dr\.\s*/, '').split(' ')[0].toLowerCase()));
    await notify(hit.map((p) => p.id), { kind: 'mention', title: req.user.name + ' mentioned you in ' + (ch.kind === 'room' ? ch.name : '#' + ch.name), body: body.slice(0, 140), link: '/messages/' + ch.id }, req.user.id);
  }
  const m = await msgQuery(ch.id).where('messages.id', id).first();
  res.json(shape(m));
});

r.post('/messages/rooms', async (req, res) => {
  if (req.user.platform_role === 'guest') return auth.forbidden(res, 'Guests can’t create rooms.');
  const name = clean(req.body.name, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) { req.flash('error', 'Give the room a name.'); return res.redirect('/messages'); }
  const ids = [].concat(req.body.members || []).map((x) => parseInt(x, 10)).filter(Boolean);
  const valid = ids.length ? (await db('users').whereIn('id', ids).where({ status: 'active' }).whereNot('platform_role', 'guest').select('id')).map((x) => x.id) : [];
  const id = await db.insertId('channels', { topic_id: null, name, kind: 'room', purpose: clean(req.body.purpose, 240), created_by: req.user.id, created_at: now() });
  await db('channel_members').insert([...new Set([req.user.id, ...valid])].map((user_id) => ({ channel_id: id, user_id })));
  await notify(valid, { kind: 'message', title: req.user.name + ' added you to the room “' + name + '”', link: '/messages/' + id }, req.user.id);
  res.redirect('/messages/' + id);
});
r.post('/topics/:tid/channels', auth.loadTopic('member'), async (req, res) => {
  const name = clean(req.body.name, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) { req.flash('error', 'Give the channel a name.'); return res.redirect('/topics/' + req.topic.id + '/channels'); }
  const id = await db.insertId('channels', { topic_id: req.topic.id, name, kind: 'topic', purpose: clean(req.body.purpose, 240), created_by: req.user.id, created_at: now() });
  await audit(req.user.id, req.topic.id, 'channel.created', 'Created channel #' + name);
  res.redirect('/messages/' + id);
});
r.post('/messages/:cid/leave', async (req, res) => {
  const ch = await db('channels').where({ id: parseInt(req.params.cid, 10), kind: 'room' }).first();
  if (ch) await db('channel_members').where({ channel_id: ch.id, user_id: req.user.id }).del();
  req.flash('ok', 'You left the room.');
  res.redirect('/messages');
});

module.exports = r;
