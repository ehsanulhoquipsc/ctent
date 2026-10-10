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

test('task flow: brief → start → steps → upload → submit → changes → v2 → approve', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  const tom = await agentFor('tom@ctent.demo');
  assert.strictEqual((await aisha.get('/topics/' + tid + '/tasks/new')).status, 403, 'members cannot create briefs');
  const page = await leader.get('/topics/' + tid + '/tasks/new');
  assert.strictEqual(page.status, 200);
  const create = await leader.post('/topics/' + tid + '/tasks/new').type('form').send({ _csrf: leader.csrf, title: 'Draft the downstream impact section', goal: 'Explain downstream effects for Assam and Bangladesh separately.', deliverable: 'doc', assignee_id: ids.aisha, priority: 'high', due_date: '2030-01-10', criteria: ['Covers India and Bangladesh separately', 'At least 8 cited sources'], steps: 'Read sources\nOutline' });
  assert.strictEqual(create.status, 302);
  const task = await db('tasks').where({ title: 'Draft the downstream impact section' }).first();
  const url = '/topics/' + tid + '/tasks/' + task.id;
  assert.strictEqual(create.headers.location, url);
  assert.strictEqual((await db('task_criteria').where({ task_id: task.id })).length, 2);
  assert.strictEqual((await db('task_steps').where({ task_id: task.id })).length, 2);
  assert.ok(await db('notifications').where({ user_id: ids.aisha }).where('title', 'like', '%gave you a task%').first());
  // Member sees "Start working"; another member cannot act on it
  assert.match((await aisha.get(url)).text, /Start working/);
  assert.strictEqual((await tom.post(url + '/act').type('form').send({ _csrf: tom.csrf, action: 'start' })).status, 403);
  await aisha.post(url + '/act').type('form').send({ _csrf: aisha.csrf, action: 'start' });
  assert.strictEqual((await db('tasks').where({ id: task.id }).first()).status, 'doing');
  // Steps
  await aisha.post(url + '/steps').type('form').send({ _csrf: aisha.csrf, text: 'Write first draft' });
  const step = await db('task_steps').where({ task_id: task.id, text: 'Read sources' }).first();
  await aisha.post(url + '/steps/' + step.id).type('form').send({ _csrf: aisha.csrf });
  assert.ok((await db('task_steps').where({ id: step.id }).first()).done);
  // Can't submit without a file; members can't move a brief task to done on the board
  await aisha.post(url + '/act').type('form').send({ _csrf: aisha.csrf, action: 'submit' });
  assert.strictEqual((await db('tasks').where({ id: task.id }).first()).status, 'doing');
  const mv = await aisha.post(url + '/move').set('Accept', 'application/json').set('x-csrf-token', aisha.csrf).send({ status: 'done' });
  assert.strictEqual(mv.status, 409);
  // Upload v1, submit
  await aisha.post(url + '/versions').field('_csrf', aisha.csrf).attach('file', Buffer.from('Downstream draft v1'), 'downstream_v1.txt');
  await aisha.post(url + '/act').type('form').send({ _csrf: aisha.csrf, action: 'submit' });
  assert.strictEqual((await db('tasks').where({ id: task.id }).first()).status, 'review');
  // It shows in the leader's Action centre
  assert.match((await leader.get('/actions')).text, /Review task “Draft the downstream impact section”/);
  // Member can't review own work; approve is refused with an unmet point
  assert.strictEqual((await aisha.post(url + '/review').type('form').send({ _csrf: aisha.csrf, decision: 'approve' })).status, 403);
  const crit = await db('task_criteria').where({ task_id: task.id }).orderBy('position');
  await leader.post(url + '/review').type('form').send({ _csrf: leader.csrf, decision: 'approve', met: [crit[0].id] });
  assert.strictEqual((await db('tasks').where({ id: task.id }).first()).status, 'review', 'approve blocked while a point is unmet');
  await leader.post(url + '/review').type('form').send({ _csrf: leader.csrf, decision: 'changes', met: [crit[0].id], reasons: ['Needs more sources'], note: 'Add Bangladesh sources' });
  let t2 = await db('tasks').where({ id: task.id }).first();
  assert.strictEqual(t2.status, 'changes');
  assert.strictEqual(t2.round, 2);
  assert.match((await aisha.get(url)).text, /Add Bangladesh sources/);
  // v2 → submit → approve
  await aisha.post(url + '/versions').field('_csrf', aisha.csrf).attach('file', Buffer.from('Downstream draft v2 with more sources'), 'downstream_v2.txt');
  await aisha.post(url + '/act').type('form').send({ _csrf: aisha.csrf, action: 'submit' });
  await leader.post(url + '/review').type('form').send({ _csrf: leader.csrf, decision: 'approve', met: crit.map((c) => c.id), note: 'Great work' });
  t2 = await db('tasks').where({ id: task.id }).first();
  assert.strictEqual(t2.status, 'done');
  const versions = await db('task_versions').where({ task_id: task.id }).orderBy('version');
  assert.deepStrictEqual(versions.map((v) => v.state), ['changes', 'approved']);
  assert.ok(await db('notifications').where({ user_id: ids.aisha }).where('title', 'like', '%approved%').first());
  // Chat and blocked updates
  await leader.post(url + '/comments').type('form').send({ _csrf: leader.csrf, body: 'Thanks <b>Aisha</b>' });
  const view = await aisha.get(url);
  assert.match(view.text, /Thanks &lt;b&gt;Aisha&lt;\/b&gt;/);
  // Guests can't open task pages
  const lin = await agentFor('lin@ctent.demo');
  const zka = await topicId('CT-0131');
  const someTask = await db('tasks').where({ topic_id: zka }).first();
  assert.strictEqual((await lin.get('/topics/' + zka + '/tasks/' + someTask.id)).status, 403);
});

test('blocked update alerts the leader in the Action centre', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const tom = await agentFor('tom@ctent.demo');
  await leader.post('/topics/' + tid + '/tasks/new').type('form').send({ _csrf: leader.csrf, title: 'Map dam diplomacy sources', assignee_id: ids.tom, criteria: ['20+ sources grouped'] });
  const task = await db('tasks').where({ title: 'Map dam diplomacy sources' }).first();
  const url = '/topics/' + tid + '/tasks/' + task.id;
  await tom.post(url + '/act').type('form').send({ _csrf: tom.csrf, action: 'start' });
  await tom.post(url + '/updates').type('form').send({ _csrf: tom.csrf, text: 'Library access is down', blocked: '1' });
  assert.ok((await db('tasks').where({ id: task.id }).first()).blocked);
  assert.match((await leader.get('/actions')).text, /is blocked on “Map dam diplomacy sources”/);
});

test('edit/delete: tasks, comments and updates respect roles', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  await leader.post('/topics/' + tid + '/tasks/new').type('form').send({ _csrf: leader.csrf, title: 'Map the treaty landscape', goal: 'g', deliverable: 'doc', assignee_id: ids.aisha, criteria: ['Lists every treaty'] });
  const task = await db('tasks').where({ title: 'Map the treaty landscape' }).first();
  const url = '/topics/' + tid + '/tasks/' + task.id;
  assert.match((await leader.get(url)).text, /Edit task/);
  assert.doesNotMatch((await aisha.get(url)).text, /Edit task/);
  assert.strictEqual((await aisha.post(url + '/edit').type('form').send({ _csrf: aisha.csrf, title: 'Hijack' })).status, 403);
  assert.strictEqual((await aisha.post(url + '/delete').type('form').send({ _csrf: aisha.csrf })).status, 403);
  assert.strictEqual((await aisha.post(url).type('form').send({ _csrf: aisha.csrf, action: 'delete' })).status, 403, 'board delete is leader/creator only');
  await leader.post(url + '/edit').type('form').send({ _csrf: leader.csrf, title: 'Map the water-treaty landscape', goal: 'new goal', criteria: 'Lists every treaty\nNotes gaps', assignee_id: ids.aisha, priority: 'high', deliverable: 'analysis', due_date: '2030-02-01' });
  const t2 = await db('tasks').where({ id: task.id }).first();
  assert.strictEqual(t2.title, 'Map the water-treaty landscape');
  assert.strictEqual(t2.due_date, '2030-02-01');
  assert.strictEqual((await db('task_criteria').where({ task_id: task.id })).length, 2);
  // Comments: own edit, others can't, leader can delete
  await aisha.post(url + '/comments').type('form').send({ _csrf: aisha.csrf, body: 'Which years?' });
  const c = await db('task_comments').where({ task_id: task.id }).first();
  await aisha.post(url + '/comments/' + c.id).type('form').send({ _csrf: aisha.csrf, body: 'Which years should I cover?' });
  const c2 = await db('task_comments').where({ id: c.id }).first();
  assert.strictEqual(c2.body, 'Which years should I cover?');
  assert.ok(c2.edited_at);
  assert.strictEqual((await leader.post(url + '/comments/' + c.id).type('form').send({ _csrf: leader.csrf, body: 'changed' })).status, 403, 'nobody edits someone else’s words');
  await leader.post(url + '/comments/' + c.id).type('form').send({ _csrf: leader.csrf, action: 'delete' });
  assert.ok(!(await db('task_comments').where({ id: c.id }).first()));
  // Updates: own edit/delete
  await aisha.post(url + '/updates').type('form').send({ _csrf: aisha.csrf, text: 'Halfway' });
  const up = await db('task_updates').where({ task_id: task.id, text: 'Halfway' }).first();
  await aisha.post(url + '/updates/' + up.id).type('form').send({ _csrf: aisha.csrf, text: 'Halfway there' });
  assert.strictEqual((await db('task_updates').where({ id: up.id }).first()).text, 'Halfway there');
  const sys = await db('task_updates').where({ task_id: task.id, kind: 'assigned' }).first();
  assert.strictEqual((await leader.post(url + '/updates/' + sys.id).type('form').send({ _csrf: leader.csrf, action: 'delete' })).status, 403, 'history entries are locked');
  await aisha.post(url + '/updates/' + up.id).type('form').send({ _csrf: aisha.csrf, action: 'delete' });
  assert.ok(!(await db('task_updates').where({ id: up.id }).first()));
  // Draft version delete
  await aisha.post(url + '/act').type('form').send({ _csrf: aisha.csrf, action: 'start' });
  await aisha.post(url + '/versions').field('_csrf', aisha.csrf).attach('file', Buffer.from('draft'), 'draft.txt');
  const v = await db('task_versions').where({ task_id: task.id }).first();
  await aisha.post(url + '/versions/' + v.id + '/delete').type('form').send({ _csrf: aisha.csrf });
  assert.ok(!(await db('task_versions').where({ id: v.id }).first()));
  assert.ok(!(await db('files').where({ id: v.file_id }).first()));
  // Leader deletes the task
  await leader.post(url + '/delete').type('form').send({ _csrf: leader.csrf });
  assert.ok(!(await db('tasks').where({ id: task.id }).first()));
});

test('edit/delete: chat messages and channels', async () => {
  const tid = await topicId('CT-0142');
  const ch = await db('channels').where({ topic_id: tid, name: 'methods' }).first();
  const api = '/api/channels/' + ch.id + '/messages';
  const aisha = await agentFor('aisha@ctent.demo');
  const priya = await agentFor('priya@ctent.demo');
  const leader = await agentFor('ehsan@ctent.demo');
  const m = (await aisha.post(api).set('x-csrf-token', aisha.csrf).send({ body: 'Typo herre' })).body;
  const first = await aisha.get(api + '?after=' + m.id + '&since=' + new Date(Date.now() - 1000).toISOString());
  assert.strictEqual((await priya.post(api + '/' + m.id).set('x-csrf-token', priya.csrf).set('Accept', 'application/json').send({ action: 'edit', body: 'x' })).status, 403);
  assert.strictEqual((await priya.post(api + '/' + m.id).set('x-csrf-token', priya.csrf).set('Accept', 'application/json').send({ action: 'delete' })).status, 403);
  const ed = await aisha.post(api + '/' + m.id).set('x-csrf-token', aisha.csrf).set('Accept', 'application/json').send({ action: 'edit', body: 'Typo here' });
  assert.strictEqual(ed.status, 200);
  assert.strictEqual(ed.body.body, 'Typo here');
  assert.ok(ed.body.edited);
  const poll = await priya.get(api + '?after=' + m.id + '&since=' + first.body.now);
  assert.ok(poll.body.changed.some((x) => x.id === m.id && x.body === 'Typo here'), 'poll returns edited messages');
  const del = await leader.post(api + '/' + m.id).set('x-csrf-token', leader.csrf).set('Accept', 'application/json').send({ action: 'delete' });
  assert.strictEqual(del.status, 200);
  assert.ok(del.body.deleted);
  assert.strictEqual(del.body.body, '');
  // Channel rename: member no, leader yes
  assert.strictEqual((await aisha.post('/messages/' + ch.id + '/edit').type('form').send({ _csrf: aisha.csrf, name: 'nope' })).status, 403);
  await leader.post('/messages/' + ch.id + '/edit').type('form').send({ _csrf: leader.csrf, name: 'Methods Lab', purpose: 'Methods' });
  assert.strictEqual((await db('channels').where({ id: ch.id }).first()).name, 'methods-lab');
  // Room: creator can delete, others cannot
  await aisha.post('/messages/rooms').type('form').send({ _csrf: aisha.csrf, name: 'temp-room', members: [ids.priya] });
  const room = await db('channels').where({ name: 'temp-room' }).first();
  assert.strictEqual((await priya.post('/messages/' + room.id + '/delete').type('form').send({ _csrf: priya.csrf })).status, 403);
  await aisha.post('/messages/' + room.id + '/delete').type('form').send({ _csrf: aisha.csrf });
  assert.ok(!(await db('channels').where({ id: room.id }).first()));
});

test('edit/delete: meetings, submissions, files, notifications, expertise', async () => {
  const tid = await topicId('CT-0142');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  const priya = await agentFor('priya@ctent.demo');
  await aisha.post('/topics/' + tid + '/meetings').type('form').send({ _csrf: aisha.csrf, title: 'Coding sync', date: '2030-03-01', time: '10:00', tz: '+11:00', duration: '60' });
  const mt = await db('meetings').where({ title: 'Coding sync' }).first();
  assert.strictEqual((await priya.post('/topics/' + tid + '/meetings/' + mt.id).type('form').send({ _csrf: priya.csrf, action: 'edit', title: 'x', date: '2030-03-01', time: '10:00' })).status, 403);
  await aisha.post('/topics/' + tid + '/meetings/' + mt.id).type('form').send({ _csrf: aisha.csrf, action: 'edit', title: 'Coding sync (moved)', date: '2030-03-02', time: '11:30', tz: '+11:00', duration: '45', link: 'https://zoom.us/j/123' });
  const mt2 = await db('meetings').where({ id: mt.id }).first();
  assert.strictEqual(mt2.title, 'Coding sync (moved)');
  assert.strictEqual(mt2.platform, 'Zoom');
  await leader.post('/topics/' + tid + '/meetings/' + mt.id).type('form').send({ _csrf: leader.csrf, action: 'delete' });
  assert.ok(!(await db('meetings').where({ id: mt.id }).first()));
  // Submissions
  await aisha.post('/topics/' + tid + '/submissions').field('_csrf', aisha.csrf).field('title', 'Interview notes').attach('file', Buffer.from('notes'), 'notes.txt');
  const s = await db('submissions').where({ title: 'Interview notes' }).first();
  assert.strictEqual((await priya.post('/topics/' + tid + '/submissions/' + s.id + '/edit').type('form').send({ _csrf: priya.csrf, title: 'x' })).status, 403);
  await aisha.post('/topics/' + tid + '/submissions/' + s.id + '/edit').type('form').send({ _csrf: aisha.csrf, title: 'Interview notes, wave 1', milestone: 'Fieldwork' });
  assert.strictEqual((await db('submissions').where({ id: s.id }).first()).milestone, 'Fieldwork');
  await aisha.post('/topics/' + tid + '/submissions/' + s.id + '/edit').type('form').send({ _csrf: aisha.csrf, action: 'delete' });
  assert.ok(!(await db('submissions').where({ id: s.id }).first()));
  // Files: rename/move by uploader; others refused
  await aisha.post('/topics/' + tid + '/files').field('_csrf', aisha.csrf).field('folder', 'Data').attach('file', Buffer.from('a,b'), 'raw.csv');
  const f = await db('files').where({ name: 'raw.csv', topic_id: tid }).first();
  assert.strictEqual((await priya.post('/topics/' + tid + '/files/' + f.id + '/edit').type('form').send({ _csrf: priya.csrf, name: 'x.csv' })).status, 403);
  await aisha.post('/topics/' + tid + '/files/' + f.id + '/edit').type('form').send({ _csrf: aisha.csrf, name: 'clean.csv', folder: 'Clean data' });
  const f2 = await db('files').where({ id: f.id }).first();
  assert.deepStrictEqual([f2.name, f2.folder], ['clean.csv', 'Clean data']);
  // Notifications: only your own
  const n = await db('notifications').where({ user_id: ids.priya }).first();
  await aisha.post('/notifications/' + n.id + '/delete').type('form').send({ _csrf: aisha.csrf });
  assert.ok(await db('notifications').where({ id: n.id }).first(), 'cannot delete someone else’s notification');
  await priya.post('/notifications/' + n.id + '/delete').type('form').send({ _csrf: priya.csrf });
  assert.ok(!(await db('notifications').where({ id: n.id }).first()));
  // Expertise level edit
  const e = await db('expertise').where({ user_id: ids.aisha }).first();
  await aisha.post('/profile/expertise/' + e.id).type('form').send({ _csrf: aisha.csrf, name: e.name, kind: e.kind, level: '1' });
  assert.strictEqual((await db('expertise').where({ id: e.id }).first()).level, 1);
});

test('admin edits and deletes user accounts safely', async () => {
  const admin = await agentFor('nadia@ctent.demo');
  const leader = await agentFor('ehsan@ctent.demo');
  assert.strictEqual((await leader.post('/admin/users/' + ids.rahul).type('form').send({ _csrf: leader.csrf, action: 'delete', confirm: 'rahul@ctent.demo' })).status, 403);
  await admin.post('/admin/users/' + ids.rahul).type('form').send({ _csrf: admin.csrf, action: 'edit', name: 'Rahul K. Mehta', email: 'rahul@ctent.demo', institution: 'KOI', title: 'Analyst' });
  assert.strictEqual((await db('users').where({ id: ids.rahul }).first()).name, 'Rahul K. Mehta');
  await admin.post('/admin/users/' + ids.rahul).type('form').send({ _csrf: admin.csrf, action: 'edit', name: 'Rahul', email: 'ehsan@ctent.demo' });
  assert.strictEqual((await db('users').where({ id: ids.rahul }).first()).email, 'rahul@ctent.demo', 'duplicate email refused');
  await admin.post('/admin/users/' + ids.rahul).type('form').send({ _csrf: admin.csrf, action: 'delete', confirm: 'wrong' });
  assert.ok(await db('users').where({ id: ids.rahul }).first(), 'needs the email typed to confirm');
  await admin.post('/admin/users/' + ids.ehsan).type('form').send({ _csrf: admin.csrf, action: 'delete', confirm: 'ehsan@ctent.demo' });
  assert.ok(await db('users').where({ id: ids.ehsan }).first(), 'sole topic leader cannot be deleted');
  await admin.post('/admin/users/' + ids.nadia).type('form').send({ _csrf: admin.csrf, action: 'delete', confirm: 'nadia@ctent.demo' });
  assert.ok(await db('users').where({ id: ids.nadia }).first(), 'admins cannot delete themselves');
  await admin.post('/admin/users/' + ids.rahul).type('form').send({ _csrf: admin.csrf, action: 'delete', confirm: 'rahul@ctent.demo' });
  assert.ok(!(await db('users').where({ id: ids.rahul }).first()));
});

test('admin can clear workspace data; accounts are kept', async () => {
  const admin = await agentFor('nadia@ctent.demo');
  const users = Number((await db('users').count({ n: '*' }).first()).n);
  const wrong = await admin.post('/admin/clear-content').type('form').send({ _csrf: admin.csrf, confirm: 'nope' });
  assert.strictEqual(wrong.status, 302);
  assert.ok(Number((await db('topics').count({ n: '*' }).first()).n) > 0, 'nothing cleared without CLEAR');
  const leader = await agentFor('ehsan@ctent.demo');
  assert.strictEqual((await leader.post('/admin/clear-content').type('form').send({ _csrf: leader.csrf, confirm: 'CLEAR' })).status, 403);
  await admin.post('/admin/clear-content').type('form').send({ _csrf: admin.csrf, confirm: 'CLEAR' });
  for (const t of ['topics', 'tasks', 'messages', 'files', 'submissions', 'notifications']) assert.strictEqual(Number((await db(t).count({ n: '*' }).first()).n), 0, t + ' cleared');
  assert.strictEqual(Number((await db('users').count({ n: '*' }).first()).n), users, 'users kept');
  // Empty workspace still renders
  for (const p of ['/', '/topics', '/messages', '/meetings', '/tasks', '/actions', '/notifications', '/admin']) assert.strictEqual((await admin.get(p)).status === 200 || (await admin.get(p)).status === 302, true, p);
});
