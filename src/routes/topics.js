'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const { notify, audit, topicLeaders } = require('../lib/events');
const { now, COLOR_NAMES } = require('../lib/util');
const { topicProgress } = require('./dashboard');

const r = express.Router();
const clean = (v, max) => String(v || '').trim().slice(0, max || 240);
const validDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

async function nextCode() {
  const rows = await db('topics').select('code');
  const max = rows.reduce((m, t) => Math.max(m, parseInt(String(t.code).replace(/\D/g, ''), 10) || 0), 100);
  return 'CT-' + String(max + 1).padStart(4, '0');
}

// ----- List -----
r.get('/topics', async (req, res) => {
  const ids = await auth.myTopicIds(req.user);
  const show = ['archived', 'completed'].includes(req.query.show) ? req.query.show : 'current';
  const all = await topicProgress(ids);
  let topics = all.filter((t) => (show === 'completed' ? t.status === 'completed' : t.status !== 'completed'));
  if (show === 'archived') topics = ids.length ? (await db('topics').whereIn('id', ids).where('status', 'archived').orderBy('id', 'desc')).map((t) => ({ ...t, total: 0, done: 0, pct: 100 })) : [];
  const roles = await db('topic_members').where({ user_id: req.user.id }).select('topic_id', 'role');
  const roleOf = Object.fromEntries(roles.map((x) => [x.topic_id, x.role]));
  const memberCounts = ids.length ? await db('topic_members').whereIn('topic_id', ids).groupBy('topic_id').select('topic_id').count({ n: '*' }) : [];
  const countOf = Object.fromEntries(memberCounts.map((x) => [x.topic_id, Number(x.n)]));
  // Topics open to join requests (institution / open visibility) that the user isn't in yet
  const pending = (await db('join_requests').where({ user_id: req.user.id, status: 'pending' }).select('topic_id')).map((x) => x.topic_id);
  const joinable = req.user.platform_role === 'guest' ? [] : await db('topics').whereNotIn('id', ids.length ? ids : [0]).whereIn('visibility', ['institution', 'open']).whereNot('status', 'archived').orderBy('id', 'desc');
  res.render('pages/topics', { title: 'Research topics', active: 'topics', topics, roleOf, countOf, show, joinable, pending,
    canCreate: auth.atLeast(req.user, 'leader'), cta: auth.atLeast(req.user, 'leader') ? { href: '/topics/new', label: 'New topic' } : null });
});

// ----- Create (leaders and admins only) -----
const TEMPLATES = {
  blank: { name: 'Blank topic', parts: [] },
  paper: { name: 'Journal paper', parts: [['Literature review', 'What has already been published on this question? Main findings, key authors and how thinking has changed.'], ['Methods in earlier studies', 'Which methods and data have other researchers used on this question, and what were their limits?'], ['Evidence & data', 'What data, statistics and case evidence exist on this question?'], ['Debates & gaps', 'Where do studies disagree, and what is still unknown?']] },
  field: { name: 'Field study', parts: [['Context & background', 'Background on the place, people and issue being studied.'], ['Earlier field studies', 'What have similar field studies found, and where were they done?'], ['Methods, sampling & ethics', 'Common methods, sampling approaches and ethical issues in similar field studies.'], ['Expected findings & gaps', 'What results would earlier work predict, and what is still unknown?']] },
  policy: { name: 'Policy analysis', parts: [['Background & context', 'How did this policy issue develop, and what rules apply today?'], ['Stakeholders & interests', 'Who is affected or involved, and what do they want?'], ['Comparative cases', 'How have other countries or regions handled the same issue?'], ['Policy options & evidence', 'Which options have been proposed, and what evidence supports each?']] },
  grant: { name: 'Grant application', parts: [['Significance & gap', 'Why does this research matter, and what gap does it fill?'], ['Evidence for the approach', 'What evidence supports the proposed methods?'], ['Similar funded projects', 'Which similar projects have been funded, and what did they achieve?']] }
};
async function newPage(req, res, v, error) {
  const people = await db('users').where({ status: 'active' }).whereNot('id', req.user.id).orderBy('name').select('id', 'name', 'color', 'title', 'institution', 'email', 'platform_role');
  res.status(error ? 400 : 200).render('pages/topic-new', { title: 'New project', active: 'topics', templates: TEMPLATES, colors: COLOR_NAMES, error, v, people, aiOn: require('../lib/llm').available() });
}
r.get('/topics/new', auth.requireRole('leader'), (req, res) => newPage(req, res, { template: require('../lib/llm').available() ? 'ai' : 'paper', color: 'burgundy', visibility: 'private' }, null));
r.post('/topics/new', auth.requireRole('leader'), async (req, res) => {
  const tplKey = req.body.template === 'ai' || TEMPLATES[req.body.template] ? req.body.template : 'blank';
  const v = { title: clean(req.body.title), description: clean(req.body.description, 2000), question: clean(req.body.question, 2000), field: clean(req.body.field, 120), due_date: validDate(req.body.due_date),
    color: COLOR_NAMES.includes(req.body.color) ? req.body.color : 'burgundy', visibility: ['private', 'institution', 'open'].includes(req.body.visibility) ? req.body.visibility : 'private', template: tplKey, invite: [].concat(req.body.invite || []).map(String) };
  if (v.title.length < 4) return newPage(req, res, v, 'Give the project a title of at least 4 characters.');
  const code = await nextCode();
  const id = await db.insertId('topics', { code, title: v.title, description: v.description, question: v.question || null, field: v.field, due_date: v.due_date, color: v.color, visibility: v.visibility, status: 'active', created_by: req.user.id, created_at: now() });
  await db('topic_members').insert({ topic_id: id, user_id: req.user.id, role: 'leader', joined_at: now() });
  await db('channels').insert({ topic_id: id, name: 'general', kind: 'topic', purpose: 'Everything about ' + code, created_by: req.user.id, created_at: now() });
  await require('../lib/rooms').ensureProjectRoom(await db('topics').where({ id }).first(), req.user.id);
  const sources = require('../lib/research').DEFAULT_SOURCES;
  let list = [], note = '';
  if (tplKey === 'ai') {
    if (v.question) {
      try { list = (await require('../lib/agent').suggestParts(v.question, v.title)).map((p) => [p.title, p.brief, p.agent]); }
      catch (e) { note = ' The AI couldn’t suggest parts just now — add them on the Research page.'; }
    } else note = ' Write the research question, then let the AI suggest parts.';
  } else if (TEMPLATES[tplKey]) list = TEMPLATES[tplKey].parts;
  let pos = 0;
  for (const [title, brief, agentName] of list) await db('parts').insert({ topic_id: id, title, description: brief, agent_name: agentName || title.split(/ [&,]/)[0] + ' agent', agent_sources: sources, agent_depth: 'standard', agent_status: 'draft', position: ++pos, status: 'open', created_at: now() });
  // Co-authors chosen in step 3
  const people = v.invite.length ? await db('users').whereIn('id', v.invite.map((x) => parseInt(x, 10)).filter(Boolean)).where({ status: 'active' }) : [];
  for (const u of people) {
    if (u.id === req.user.id) continue;
    await db('topic_members').insert({ topic_id: id, user_id: u.id, role: u.platform_role === 'guest' ? 'guest' : 'member', joined_at: now() });
    await notify(u.id, { kind: 'access', title: req.user.name + ' added you to ' + code, body: v.title, link: '/topics/' + id }, req.user.id);
  }
  await audit(req.user.id, id, 'topic.created', 'Created project ' + code + (list.length ? ' with ' + list.length + ' parts' : '') + (people.length ? ' and ' + people.length + ' co-author' + (people.length === 1 ? '' : 's') : ''));
  req.flash(note ? 'error' : 'ok', 'Project ' + code + ' created.' + (list.length ? ' Check the ' + list.length + ' parts, then launch the agents.' : '') + note);
  res.redirect('/topics/' + id + '/agents');
});

// ----- Join requests -----
r.post('/topics/:tid/request', async (req, res) => {
  const tid = parseInt(req.params.tid, 10);
  const topic = await db('topics').where({ id: tid }).whereIn('visibility', ['institution', 'open']).first();
  if (!topic || req.user.platform_role === 'guest') return auth.notFound(res);
  const exists = await db('join_requests').where({ topic_id: tid, user_id: req.user.id, status: 'pending' }).first();
  const member = await db('topic_members').where({ topic_id: tid, user_id: req.user.id }).first();
  if (!exists && !member) {
    await db('join_requests').insert({ topic_id: tid, user_id: req.user.id, message: clean(req.body.message, 500) || null, status: 'pending', created_at: now() });
    await notify(await topicLeaders(tid), { kind: 'request', title: req.user.name + ' asked to join ' + topic.code, body: clean(req.body.message, 200), link: '/actions' }, req.user.id);
  }
  req.flash('ok', 'Request sent. The topic leader will review it.');
  res.redirect('/topics');
});
r.post('/topics/:tid/request/cancel', async (req, res) => {
  await db('join_requests').where({ topic_id: parseInt(req.params.tid, 10), user_id: req.user.id, status: 'pending' }).del();
  req.flash('ok', 'Request cancelled.');
  res.redirect('/topics');
});
r.post('/requests/:rid', async (req, res) => {
  const jr = await db('join_requests').where({ id: parseInt(req.params.rid, 10), status: 'pending' }).first();
  if (!jr) return auth.notFound(res, 'That request was already handled.');
  const { role } = await auth.topicAccess(req.user, jr.topic_id);
  if (role !== 'leader') return auth.forbidden(res, 'Only the topic leader can answer join requests.');
  const decision = req.body.decision === 'accepted' ? 'accepted' : 'declined';
  await db('join_requests').where({ id: jr.id }).update({ status: decision });
  const topic = await db('topics').where({ id: jr.topic_id }).first();
  const person = await db('users').where({ id: jr.user_id }).first();
  if (decision === 'accepted' && !(await db('topic_members').where({ topic_id: jr.topic_id, user_id: jr.user_id }).first())) {
    await db('topic_members').insert({ topic_id: jr.topic_id, user_id: jr.user_id, role: 'member', joined_at: now() });
  }
  await notify(jr.user_id, { kind: 'access', title: decision === 'accepted' ? 'You joined ' + topic.code : 'Your request to join ' + topic.code + ' was declined', link: decision === 'accepted' ? '/topics/' + topic.id : '/topics' });
  await audit(req.user.id, jr.topic_id, 'member.' + decision, (decision === 'accepted' ? 'Accepted ' : 'Declined ') + person.name + '’s join request');
  req.flash('ok', decision === 'accepted' ? person.name + ' is now a member of ' + topic.code + '.' : 'Request declined.');
  res.redirect('/actions');
});

// ----- Overview -----
r.get('/topics/:tid', auth.loadTopic(), async (req, res) => {
  const t = req.topic;
  const [prog] = await topicProgress([t.id]);
  const parts = await db('parts').leftJoin('users', 'users.id', 'parts.proposed_user_id').where('parts.topic_id', t.id).orderBy('parts.position').orderBy('parts.id').select('parts.*', 'users.name as owner', 'users.color as owner_color', 'users.id as owner_id');
  const meetings = await db('meetings').where({ topic_id: t.id }).where('starts_at', '>=', new Date(Date.now() - 3600000).toISOString()).orderBy('starts_at').limit(3);
  const activity = await db('audit_log').leftJoin('users', 'users.id', 'audit_log.user_id').where('audit_log.topic_id', t.id).orderBy('audit_log.id', 'desc').limit(6).select('audit_log.*', 'users.name', 'users.color', 'users.id as uid');
  const subs = await db('submissions').where({ topic_id: t.id }).groupBy('status').select('status').count({ n: '*' });
  const members = await db('topic_members').where({ topic_id: t.id }).count({ n: '*' }).first();
  res.render('pages/topic-overview', { title: t.title, active: 'topics', tab: 'Overview', crumb: '<a href="/topics">Topics</a> / ' + t.code, prog: prog || { total: 0, done: 0, pct: 0 }, parts, meetings, activity, subs, memberCount: Number(members.n) });
});

// ----- Members -----
r.get('/topics/:tid/members', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  const members = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where('topic_members.topic_id', t.id)
    .orderByRaw("case topic_members.role when 'leader' then 0 when 'member' then 1 else 2 end").orderBy('users.name')
    .select('users.id', 'users.name', 'users.email', 'users.title', 'users.color', 'users.institution', 'topic_members.role', 'topic_members.joined_at');
  const open = await db('tasks').where({ topic_id: t.id }).whereNot('status', 'done').groupBy('assignee_id').select('assignee_id').count({ n: '*' });
  const load = Object.fromEntries(open.map((x) => [x.assignee_id, Number(x.n)]));
  const others = res.locals.isTopicLeader ? await db('users').where({ status: 'active' }).whereNotIn('id', members.map((m) => m.id)).orderBy('name').select('id', 'name', 'email', 'platform_role') : [];
  res.render('pages/topic-members', { title: 'Members · ' + t.code, active: 'topics', tab: 'Members', crumb: '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / Members', members, load, others });
});
r.post('/topics/:tid/members', auth.loadTopic('leader'), async (req, res) => {
  const t = req.topic;
  const user = await db('users').where({ id: parseInt(req.body.user_id, 10), status: 'active' }).first();
  if (!user) { req.flash('error', 'Pick a person to add.'); return res.redirect('/topics/' + t.id + '/members'); }
  let role = ['leader', 'member', 'guest'].includes(req.body.role) ? req.body.role : 'member';
  if (user.platform_role === 'guest') role = 'guest';
  if (!(await db('topic_members').where({ topic_id: t.id, user_id: user.id }).first())) {
    await db('topic_members').insert({ topic_id: t.id, user_id: user.id, role, joined_at: now() });
    await notify(user.id, { kind: 'access', title: req.user.name + ' added you to ' + t.code, body: t.title, link: '/topics/' + t.id }, req.user.id);
    await audit(req.user.id, t.id, 'member.added', 'Added ' + user.name + ' as ' + role);
  }
  req.flash('ok', user.name + ' added as ' + role + '.');
  res.redirect('/topics/' + t.id + '/members');
});
r.post('/topics/:tid/members/:uid', auth.loadTopic('leader'), async (req, res) => {
  const t = req.topic;
  const uid = parseInt(req.params.uid, 10);
  const m = await db('topic_members').where({ topic_id: t.id, user_id: uid }).first();
  const person = await db('users').where({ id: uid }).first();
  if (!m || !person) return auth.notFound(res);
  const leaders = await db('topic_members').where({ topic_id: t.id, role: 'leader' }).count({ n: '*' }).first();
  const lastLeader = m.role === 'leader' && Number(leaders.n) <= 1;
  if (req.body.action === 'remove') {
    if (lastLeader) { req.flash('error', 'A topic needs at least one leader. Make someone else leader first.'); return res.redirect('/topics/' + t.id + '/members'); }
    await db('topic_members').where({ topic_id: t.id, user_id: uid }).del();
    await audit(req.user.id, t.id, 'member.removed', 'Removed ' + person.name);
    req.flash('ok', person.name + ' removed from ' + t.code + '.');
  } else {
    let role = ['leader', 'member', 'guest'].includes(req.body.role) ? req.body.role : m.role;
    if (person.platform_role === 'guest') role = 'guest';
    if (lastLeader && role !== 'leader') { req.flash('error', 'A topic needs at least one leader.'); return res.redirect('/topics/' + t.id + '/members'); }
    await db('topic_members').where({ topic_id: t.id, user_id: uid }).update({ role });
    await audit(req.user.id, t.id, 'member.role', 'Changed ' + person.name + '’s role to ' + role);
    req.flash('ok', person.name + ' is now ' + role + '.');
  }
  res.redirect('/topics/' + t.id + '/members');
});

// ----- Settings -----
r.get('/topics/:tid/settings', auth.loadTopic('leader'), (req, res) => {
  res.render('pages/topic-settings', { title: 'Settings · ' + req.topic.code, active: 'topics', tab: 'Settings', crumb: '<a href="/topics">Topics</a> / <a href="/topics/' + req.topic.id + '">' + req.topic.code + '</a> / Settings', colors: COLOR_NAMES });
});
r.post('/topics/:tid/settings', auth.loadTopic('leader'), async (req, res) => {
  const t = req.topic;
  const upd = { title: clean(req.body.title) || t.title, description: clean(req.body.description, 2000), field: clean(req.body.field, 120), due_date: validDate(req.body.due_date),
    color: COLOR_NAMES.includes(req.body.color) ? req.body.color : t.color, visibility: ['private', 'institution', 'open'].includes(req.body.visibility) ? req.body.visibility : t.visibility,
    status: t.status !== 'completed' && ['planning', 'active', 'review'].includes(req.body.status) ? req.body.status : t.status };
  await db('topics').where({ id: t.id }).update(upd);
  await audit(req.user.id, t.id, 'topic.settings', 'Updated topic settings');
  req.flash('ok', 'Settings saved.');
  res.redirect('/topics/' + t.id + '/settings');
});
r.post('/topics/:tid/archive', auth.loadTopic('leader'), async (req, res) => {
  const t = req.topic;
  const archive = t.status !== 'archived';
  await db('topics').where({ id: t.id }).update({ status: archive ? 'archived' : 'active' });
  await audit(req.user.id, t.id, archive ? 'topic.archived' : 'topic.reopened', (archive ? 'Archived ' : 'Reopened ') + t.code);
  req.flash('ok', archive ? t.code + ' archived. It is now read-only for members.' : t.code + ' reopened.');
  res.redirect('/topics/' + t.id + '/settings');
});
r.post('/topics/:tid/delete', auth.loadTopic('leader'), async (req, res) => {
  const t = req.topic;
  if (String(req.body.confirm || '').trim() !== t.code) { req.flash('error', 'Type ' + t.code + ' exactly to confirm deletion.'); return res.redirect('/topics/' + t.id + '/settings'); }
  await audit(req.user.id, null, 'topic.deleted', 'Deleted topic ' + t.code + ' — ' + t.title);
  await db('topics').where({ id: t.id }).del();
  req.flash('ok', t.code + ' was deleted.');
  res.redirect('/topics');
});

// ----- Activity -----
r.get('/topics/:tid/activity', auth.loadTopic('member'), async (req, res) => {
  const t = req.topic;
  let q = db('audit_log').leftJoin('users', 'users.id', 'audit_log.user_id').where('audit_log.topic_id', t.id);
  if (!res.locals.isTopicLeader) q = q.where('audit_log.user_id', req.user.id);
  const log = await q.orderBy('audit_log.id', 'desc').limit(200).select('audit_log.*', 'users.name', 'users.color', 'users.id as uid');
  res.render('pages/topic-activity', { title: 'Activity · ' + t.code, active: 'topics', tab: 'Activity', crumb: '<a href="/topics">Topics</a> / <a href="/topics/' + t.id + '">' + t.code + '</a> / Activity', log });
});

module.exports = r;
module.exports.TEMPLATES = TEMPLATES;
