'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const tmp = path.join(os.tmpdir(), 'ctent-test-' + process.pid + '.sqlite');
process.env.SQLITE_FILE = tmp;
process.env.NODE_ENV = 'test';
// Set TEST_DATABASE_URL to run the same tests against PostgreSQL.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;

const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');

let app, ids;
before(async () => { await db.migrate.rollback(undefined, true); await db.migrate.latest(); ids = await seedDemo(); app = createApp(); });
after(async () => { await db.destroy(); fs.rmSync(tmp, { force: true }); });

// A signed-in browser-like agent that keeps cookies and knows its CSRF token.
async function agentFor(email, password = 'demo1234') {
  const a = request.agent(app);
  const page = await a.get('/login');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await a.post('/login').type('form').send({ _csrf: csrf, email, password, next: '/' });
  assert.strictEqual(res.status, 302, 'login should redirect for ' + email);
  const home = await a.get('/');
  a.csrf = home.text.match(/name="csrf" content="([^"]+)"/)[1];
  return a;
}
const topicId = async (code) => (await db('topics').where({ code }).first()).id;

test('signed-out visitors are sent to sign in', async () => {
  const res = await request(app).get('/topics');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});

test('wrong password is rejected', async () => {
  const a = request.agent(app);
  const page = await a.get('/login');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await a.post('/login').type('form').send({ _csrf: csrf, email: 'ehsan@ctent.demo', password: 'nope' });
  assert.strictEqual(res.status, 401);
  assert.match(res.text, /don’t match/);
});

test('forms without a CSRF token are refused', async () => {
  const a = await agentFor('ehsan@ctent.demo');
  const res = await a.post('/topics/new').type('form').send({ title: 'No token topic' });
  assert.strictEqual(res.status, 403);
});

test('setup page is closed once users exist', async () => {
  const res = await request(app).get('/setup');
  assert.strictEqual(res.status, 302);
});

test('members cannot create topics; leaders can', async () => {
  const member = await agentFor('aisha@ctent.demo');
  assert.strictEqual((await member.get('/topics/new')).status, 403);
  const leader = await agentFor('ehsan@ctent.demo');
  const res = await leader.post('/topics/new').type('form').send({ _csrf: leader.csrf, title: 'Mangrove restoration and livelihoods', template: 'field', visibility: 'private', color: 'teal' });
  assert.strictEqual(res.status, 302);
  const t = await db('topics').where({ title: 'Mangrove restoration and livelihoods' }).first();
  assert.ok(t, 'topic saved');
  assert.strictEqual((await db('parts').where({ topic_id: t.id })).length, 4, 'template parts created');
  assert.ok(await db('topic_members').where({ topic_id: t.id, user_id: ids.ehsan, role: 'leader' }).first());
});

test('members only see topics they belong to', async () => {
  const rahul = await agentFor('rahul@ctent.demo');
  const res = await rahul.get('/topics/' + (await topicId('CT-0142')));
  assert.strictEqual(res.status, 403);
  const list = await rahul.get('/topics');
  assert.doesNotMatch(list.text, /Climate-induced migration in coastal Bangladesh/);
});

test('guests are read-only and cannot see the board or messages', async () => {
  const lin = await agentFor('lin@ctent.demo');
  const tid = await topicId('CT-0142');
  assert.strictEqual((await lin.get('/topics/' + tid)).status, 200);
  assert.strictEqual((await lin.get('/topics/' + tid + '/submissions')).status, 200);
  assert.strictEqual((await lin.get('/topics/' + tid + '/board')).status, 403);
  const ch = await db('channels').where({ topic_id: tid }).first();
  assert.strictEqual((await lin.get('/messages/' + ch.id)).status, 404);
  const post = await lin.post('/topics/' + tid + '/tasks').type('form').send({ _csrf: lin.csrf, title: 'Sneaky task' });
  assert.strictEqual(post.status, 403);
});

test('admin console is admin-only', async () => {
  assert.strictEqual((await (await agentFor('ehsan@ctent.demo')).get('/admin')).status, 403);
  assert.strictEqual((await (await agentFor('nadia@ctent.demo')).get('/admin')).status, 200);
});

test('leader approves a part owner: task created and owner notified', async () => {
  const leader = await agentFor('ehsan@ctent.demo');
  const tid = await topicId('CT-0150');
  const part = await db('parts').where({ topic_id: tid, title: 'Flow & flood modelling' }).first();
  await db('topic_members').insert({ topic_id: tid, user_id: ids.rahul, role: 'member' });
  const res = await leader.post('/topics/' + tid + '/plan/' + part.id).type('form').send({ _csrf: leader.csrf, user_id: ids.rahul, action: 'approve' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual((await db('parts').where({ id: part.id }).first()).status, 'approved');
  const task = await db('tasks').where({ part_id: part.id }).first();
  assert.strictEqual(task.assignee_id, ids.rahul);
  assert.ok(await db('notifications').where({ user_id: ids.rahul }).where('title', 'like', '%Flow & flood modelling%').first());
});

test('members cannot approve parts', async () => {
  const aisha = await agentFor('aisha@ctent.demo');
  const tid = await topicId('CT-0150');
  const part = await db('parts').where({ topic_id: tid, title: 'Literature map — dam diplomacy' }).first();
  const res = await aisha.post('/topics/' + tid + '/plan/' + part.id).type('form').send({ _csrf: aisha.csrf, user_id: ids.aisha, action: 'approve' });
  assert.strictEqual(res.status, 403);
});

test('board: assignee moves own task; others cannot', async () => {
  const tid = await topicId('CT-0142');
  const task = await db('tasks').where({ topic_id: tid, title: 'Train enumerators — Satkhira' }).first();
  const sara = await agentFor('sara@ctent.demo');
  const ok = await sara.post('/topics/' + tid + '/tasks/' + task.id + '/move').set('Accept', 'application/json').set('x-csrf-token', sara.csrf).send({ status: 'review' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await db('tasks').where({ id: task.id }).first()).status, 'review');
  const tom = await agentFor('tom@ctent.demo');
  const no = await tom.post('/topics/' + tid + '/tasks/' + task.id + '/move').set('Accept', 'application/json').set('x-csrf-token', tom.csrf).send({ status: 'done' });
  assert.strictEqual(no.status, 403);
});

test('submission upload, new version and review', async () => {
  const tid = await topicId('CT-0142');
  const tom = await agentFor('tom@ctent.demo');
  const up = await tom.post('/topics/' + tid + '/submissions').field('_csrf', tom.csrf).field('title', 'Wave 2 codebook').field('milestone', 'Data').attach('file', Buffer.from('var,label\nq1,Age\n'), 'codebook.csv');
  assert.strictEqual(up.status, 302);
  const s = await db('submissions').where({ title: 'Wave 2 codebook' }).first();
  assert.ok(s);
  const v2 = await tom.post('/topics/' + tid + '/submissions/' + s.id + '/version').field('_csrf', tom.csrf).field('note', 'Added q2').attach('file', Buffer.from('var,label\nq1,Age\nq2,Income\n'), 'codebook.csv');
  assert.strictEqual(v2.status, 302);
  const leader = await agentFor('ehsan@ctent.demo');
  const page = await leader.get('/topics/' + tid + '/submissions/' + s.id);
  assert.match(page.text, /What changed: v1/);
  const rv = await leader.post('/topics/' + tid + '/submissions/' + s.id + '/review').type('form').send({ _csrf: leader.csrf, decision: 'approved', comment: 'Looks good' });
  assert.strictEqual(rv.status, 302);
  assert.strictEqual((await db('submissions').where({ id: s.id }).first()).status, 'approved');
  // Authors cannot review their own work
  const self = await tom.post('/topics/' + tid + '/submissions/' + s.id + '/review').type('form').send({ _csrf: tom.csrf, decision: 'approved' });
  assert.strictEqual(self.status, 403);
});

test('uploads without a CSRF token are refused', async () => {
  const tid = await topicId('CT-0142');
  const tom = await agentFor('tom@ctent.demo');
  const res = await tom.post('/topics/' + tid + '/files').field('folder', 'Data').attach('file', Buffer.from('x'), 'x.txt');
  assert.strictEqual(res.status, 403);
});

test('executable uploads are blocked', async () => {
  const tid = await topicId('CT-0142');
  const tom = await agentFor('tom@ctent.demo');
  await tom.post('/topics/' + tid + '/files').field('_csrf', tom.csrf).field('folder', 'Data').attach('file', Buffer.from('MZ'), 'evil.exe');
  assert.strictEqual(await db('files').where({ name: 'evil.exe' }).first(), undefined);
});

test('files download only for topic members', async () => {
  const f = await db('files').where({ name: 'sampling_frame_v2.csv' }).first();
  const priya = await agentFor('priya@ctent.demo');
  const ok = await priya.get('/topics/' + f.topic_id + '/files/' + f.id);
  assert.strictEqual(ok.status, 200);
  assert.match(ok.headers['content-disposition'], /attachment/);
  const rahul = await agentFor('rahul@ctent.demo');
  assert.strictEqual((await rahul.get('/topics/' + f.topic_id + '/files/' + f.id)).status, 403);
});

test('messages: send, mention notifies, and HTML is escaped', async () => {
  const tid = await topicId('CT-0142');
  const ch = await db('channels').where({ topic_id: tid, name: 'methods' }).first();
  const aisha = await agentFor('aisha@ctent.demo');
  const res = await aisha.post('/api/channels/' + ch.id + '/messages').set('x-csrf-token', aisha.csrf).send({ body: '<script>alert(1)</script> @Priya please check' });
  assert.strictEqual(res.status, 200);
  assert.ok(await db('notifications').where({ user_id: ids.priya, kind: 'mention' }).first());
  const page = await aisha.get('/messages/' + ch.id);
  assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('join request: leader accepts and person becomes a member', async () => {
  const jr = await db('join_requests').where({ status: 'pending' }).first();
  const leader = await agentFor('ehsan@ctent.demo');
  const res = await leader.post('/requests/' + jr.id).type('form').send({ _csrf: leader.csrf, decision: 'accepted' });
  assert.strictEqual(res.status, 302);
  assert.ok(await db('topic_members').where({ topic_id: jr.topic_id, user_id: jr.user_id }).first());
});

test('admin creates a user who can then sign in; suspended users cannot', async () => {
  const admin = await agentFor('nadia@ctent.demo');
  await admin.post('/admin/users').type('form').send({ _csrf: admin.csrf, name: 'Maya Lopez', email: 'maya@example.org', role: 'member' });
  const page = await admin.get('/admin');
  const pw = page.text.match(/maya@example\.org · ([^<]+)<\/span>/)[1].trim();
  await agentFor('maya@example.org', pw);
  const maya = await db('users').where({ email: 'maya@example.org' }).first();
  await admin.post('/admin/users/' + maya.id).type('form').send({ _csrf: admin.csrf, action: 'status' });
  const a = request.agent(app);
  const lp = await a.get('/login');
  const csrf = lp.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await a.post('/login').type('form').send({ _csrf: csrf, email: 'maya@example.org', password: pw });
  assert.strictEqual(res.status, 401);
});

test('archived topics are read-only', async () => {
  const leader = await agentFor('james@ctent.demo');
  const tid = await topicId('CT-0131');
  await leader.post('/topics/' + tid + '/archive').type('form').send({ _csrf: leader.csrf });
  assert.strictEqual((await db('topics').where({ id: tid }).first()).status, 'archived');
  await leader.post('/topics/' + tid + '/tasks').type('form').send({ _csrf: leader.csrf, title: 'Should not be added' });
  assert.strictEqual(await db('tasks').where({ title: 'Should not be added' }).first(), undefined);
});

test('every main page renders for a leader', async () => {
  const a = await agentFor('ehsan@ctent.demo');
  const tid = await topicId('CT-0142');
  for (const p of ['/', '/tasks', '/actions', '/notifications', '/meetings', '/messages', '/topics', '/profile', '/search?q=sampling', '/people/' + ids.aisha,
    '/topics/' + tid, '/topics/' + tid + '/plan', '/topics/' + tid + '/board', '/topics/' + tid + '/meetings', '/topics/' + tid + '/members', '/topics/' + tid + '/submissions', '/topics/' + tid + '/files', '/topics/' + tid + '/activity', '/topics/' + tid + '/settings']) {
    const res = await a.get(p);
    assert.ok([200, 302].includes(res.status), p + ' returned ' + res.status);
  }
});
