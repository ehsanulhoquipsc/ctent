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

test('a task assigned by someone else is locked for the assignee, even a co-leader', async () => {
  const tid = await topicId('CT-0142');
  await db('topic_members').where({ topic_id: tid, user_id: ids.aisha }).update({ role: 'leader' });
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  await leader.post('/topics/' + tid + '/tasks').type('form').send({ _csrf: leader.csrf, title: 'Code wave 2 transcripts', assignee_id: ids.aisha, status: 'todo' });
  const task = await db('tasks').where({ title: 'Code wave 2 transcripts' }).first();
  assert.strictEqual(task.assignee_id, ids.aisha);
  const url = '/topics/' + tid + '/tasks/' + task.id;
  assert.match((await aisha.get('/topics/' + tid + '/board')).text, /Assigned to you/);
  assert.strictEqual((await aisha.post(url).type('form').send({ _csrf: aisha.csrf, assignee_id: '' })).status, 403, 'cannot unassign');
  assert.strictEqual((await aisha.post(url).type('form').send({ _csrf: aisha.csrf, action: 'delete' })).status, 403, 'cannot delete');
  assert.strictEqual((await aisha.post(url + '/delete').type('form').send({ _csrf: aisha.csrf })).status, 403);
  assert.strictEqual((await aisha.post(url + '/edit').type('form').send({ _csrf: aisha.csrf, title: 'Something else' })).status, 403);
  assert.strictEqual((await aisha.post(url + '/move').set('Accept', 'application/json').set('x-csrf-token', aisha.csrf).send({ status: 'done' })).status, 409, 'cannot close it herself');
  assert.strictEqual((await aisha.post(url + '/move').set('Accept', 'application/json').set('x-csrf-token', aisha.csrf).send({ status: 'review' })).status, 200, 'can send it for review');
  await leader.post(url + '/move').set('Accept', 'application/json').set('x-csrf-token', leader.csrf).send({ status: 'done' });
  assert.strictEqual((await db('tasks').where({ id: task.id }).first()).status, 'done');
  await db('topic_members').where({ topic_id: tid, user_id: ids.aisha }).update({ role: 'member' });
});

test('meeting rooms: automatic project room, team rooms from a part, scoped invites', async () => {
  const tid = await topicId('CT-0142');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  const priya = await agentFor('priya@ctent.demo');
  const page = await aisha.get('/topics/' + tid + '/meetings');
  assert.strictEqual(page.status, 200);
  const project = await db('meeting_rooms').where({ topic_id: tid, kind: 'project' }).first();
  assert.ok(project && /^https:\/\/meet\.jit\.si\//.test(project.link), 'project room made automatically with a video link');
  assert.match(page.text, /Project room · everyone/);
  // New topics get one straight away
  await leader.post('/topics/new').type('form').send({ _csrf: leader.csrf, title: 'Room test topic', code: '', template: 'paper', visibility: 'private' });
  const nt = await db('topics').where({ title: 'Room test topic' }).first();
  if (nt) assert.ok(await db('meeting_rooms').where({ topic_id: nt.id, kind: 'project' }).first());
  // Team room: Aisha + Tom
  await aisha.post('/topics/' + tid + '/rooms').type('form').send({ _csrf: aisha.csrf, name: 'Field team', members: [ids.tom], chat: '1' });
  const room = await db('meeting_rooms').where({ name: 'Field team' }).first();
  const who = (await db('meeting_room_members').where({ room_id: room.id })).map((x) => x.user_id).sort();
  assert.deepStrictEqual(who, [ids.aisha, ids.tom].sort());
  assert.ok(room.channel_id && await db('channel_members').where({ channel_id: room.channel_id, user_id: ids.tom }).first(), 'room chat created');
  assert.doesNotMatch((await priya.get('/topics/' + tid + '/meetings')).text, /Field team/, 'other members don’t see private team rooms');
  assert.strictEqual((await priya.post('/topics/' + tid + '/rooms/' + room.id).type('form').send({ _csrf: priya.csrf, name: 'x' })).status, 403);
  // Meeting in the team room notifies only its people and uses its link
  await aisha.post('/topics/' + tid + '/meetings').type('form').send({ _csrf: aisha.csrf, title: 'Field sync', date: '2030-04-01', time: '09:00', tz: '+11:00', duration: '30', room_id: room.id });
  const m = await db('meetings').where({ title: 'Field sync' }).first();
  assert.strictEqual(m.link, room.link);
  assert.ok(await db('notifications').where({ user_id: ids.tom }).where('title', 'like', '%Field sync%').first());
  assert.ok(!(await db('notifications').where({ user_id: ids.priya }).where('title', 'like', '%Field sync%').first()));
  // Edit members, then project room is protected
  await aisha.post('/topics/' + tid + '/rooms/' + room.id).type('form').send({ _csrf: aisha.csrf, name: 'Field team', members: [ids.aisha, ids.priya] });
  assert.ok(await db('channel_members').where({ channel_id: room.channel_id, user_id: ids.priya }).first());
  assert.ok(!(await db('channel_members').where({ channel_id: room.channel_id, user_id: ids.tom }).first()));
  assert.strictEqual((await aisha.post('/topics/' + tid + '/rooms/' + project.id).type('form').send({ _csrf: aisha.csrf, link: 'https://zoom.us/j/1' })).status, 403);
  await leader.post('/topics/' + tid + '/rooms/' + project.id).type('form').send({ _csrf: leader.csrf, name: project.name, link: 'https://zoom.us/j/999' });
  assert.strictEqual((await db('meeting_rooms').where({ id: project.id }).first()).platform, 'Zoom');
  await leader.post('/topics/' + tid + '/rooms/' + project.id).type('form').send({ _csrf: leader.csrf, action: 'delete' });
  assert.ok(await db('meeting_rooms').where({ id: project.id }).first(), 'project room can’t be deleted');
  await aisha.post('/topics/' + tid + '/rooms/' + room.id).type('form').send({ _csrf: aisha.csrf, action: 'delete' });
  assert.ok(!(await db('meeting_rooms').where({ id: room.id }).first()));
  assert.match((await aisha.get('/meetings')).text, /Your rooms/);
});

test('finish project: leader picks the final report; members can open it later', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  // Task assignment shows each person's expertise
  assert.match((await leader.get('/topics/' + tid + '/tasks/new')).text, /class="skill-chips"/);
  assert.strictEqual((await aisha.get('/topics/' + tid + '/finish')).status, 302, 'members can’t open finish before completion');
  assert.strictEqual((await aisha.post('/topics/' + tid + '/finish').field('_csrf', aisha.csrf).field('file_id', '1')).status, 403);
  const page = await leader.get('/topics/' + tid + '/finish');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Choose the final report/);
  await leader.post('/topics/' + tid + '/finish').field('_csrf', leader.csrf).field('final_title', 'Medog dam — final report').field('final_note', 'Submitted to the journal.').attach('file', Buffer.from('final text'), 'final.txt');
  const t = await db('topics').where({ id: tid }).first();
  assert.strictEqual(t.status, 'completed');
  assert.strictEqual(t.final_title, 'Medog dam — final report');
  assert.ok(t.final_file_id && t.completed_at);
  assert.ok(await db('notifications').where({ user_id: ids.aisha }).where('title', 'like', '%is complete%').first());
  const view = await aisha.get('/topics/' + tid + '/finish');
  assert.match(view.text, /Congratulations, team!/);
  assert.match(view.text, /Medog dam — final report/);
  assert.doesNotMatch(view.text, /Change the final report/, 'only leaders can change it');
  assert.match((await aisha.get('/topics/' + tid)).text, /Open final report/);
  assert.match((await aisha.get('/topics?show=completed')).text, /Final report/);
  // The final report can't be deleted while it is the final report
  await leader.post('/topics/' + tid + '/files/' + t.final_file_id + '/delete').type('form').send({ _csrf: leader.csrf });
  assert.ok(await db('files').where({ id: t.final_file_id }).first());
  // Change to another file, then reopen
  const other = await db('files').where({ topic_id: tid }).whereNot('id', t.final_file_id).first();
  if (other) {
    await leader.post('/topics/' + tid + '/finish').field('_csrf', leader.csrf).field('file_id', String(other.id)).field('final_title', 'v2');
    assert.strictEqual((await db('topics').where({ id: tid }).first()).final_file_id, other.id);
  }
  await leader.post('/topics/' + tid + '/finish/reopen').type('form').send({ _csrf: leader.csrf });
  const r = await db('topics').where({ id: tid }).first();
  assert.strictEqual(r.status, 'active');
  assert.ok(r.final_file_id, 'report kept after reopening');
});

test('language switch: Bengali interface, user content kept as typed', async () => {
  const anon = request.agent(app);
  const sw = await anon.get('/lang/bn?next=/login');
  assert.strictEqual(sw.status, 302);
  assert.match(sw.headers['set-cookie'].join(';'), /lang=bn/);
  const login = await anon.get('/login');
  assert.match(login.text, /<html lang="bn"/);
  assert.match(login.text, /সাইন ইন/);
  const leader = await agentFor('ehsan@ctent.demo');
  const tid = await topicId('CT-0142');
  await leader.post('/topics/' + tid + '/tasks').type('form').send({ _csrf: leader.csrf, title: 'Delete old files — Done', status: 'todo' });
  await leader.get('/lang/bn');
  const board = await leader.get('/topics/' + tid + '/board');
  assert.match(board.text, /বোর্ড/);
  assert.match(board.text, /Delete old files — Done/, 'task titles are not translated');
  const dash = await leader.get('/');
  assert.match(dash.text, /ড্যাশবোর্ড/);
  assert.doesNotMatch(dash.text, />Dashboard</);
  // Errors from the JSON API are translated too
  const m = await leader.post('/topics/' + tid + '/tasks/999999/move').set('Accept', 'application/json').set('x-csrf-token', leader.csrf).send({ status: 'done' });
  assert.strictEqual(m.status, 404);
  await leader.get('/lang/en');
  assert.match((await leader.get('/')).text, />Dashboard</);
  assert.strictEqual((await leader.get('/lang/xx?next=//evil.com')).headers.location, '/', 'no open redirects');
});

// ---------- AI agents (external services are mocked) ----------
function mockServices({ failSearch = false } = {}) {
  const real = global.fetch;
  const calls = [];
  const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj), arrayBuffer: async () => Buffer.from(JSON.stringify(obj)) });
  const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found', arrayBuffer: async () => Buffer.from('') });
  const down = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'down' });
  const abstract = Object.fromEntries('This study finds that flow matters downstream. It also notes gaps in the dry season record for Bangladesh.'.split(' ').map((w, i) => [w, [i]]));
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
      const body = JSON.parse(opts.body || '{}');
      const prompt = body.contents[0].parts[0].text;
      let out;
      if (prompt.includes('senior research planner')) out = { topic_query: 'dam downstream flow', topic_query_bn: 'বাঁধ', questions: [{ question: 'How does dam storage change dry-season flow?', query: 'dam dry season flow', query_bn: '' }, { question: 'What do treaties say about sharing water?', query: 'brahmaputra water treaty', query_bn: '' }], islamic_keywords: [], islamic_keywords_bn: [] };
      else if (prompt.includes('Suggest 3 to 6 parts')) out = { parts: [{ title: 'Hydrology baseline', brief: 'How much water flows and when.', agent: 'Hydrology agent' }, { title: 'Treaties and law', brief: 'Which agreements apply.', agent: 'Legal agent' }] };
      else if (prompt.includes('For each source below')) {
        const n = (prompt.match(/\[id=\d+\]/g) || []).length;
        out = { items: Array.from({ length: n }, (_, i) => ({ id: i, relevance: i === n - 1 ? 1 : 4, findings: [i === 0 ? 'Finding A about flow.' : 'Finding ' + i + ' about floods.'], data_points: i === 0 ? ['23% less dry-season flow (2010-2020)'] : [], method: i === 0 ? 'case study' : '', sample: i === 0 ? 'Bangladesh, 2010-2020' : '', limitations: i === 1 ? 'Small sample' : '', future_research: i === 1 ? 'Study the dry season' : '', method_type: i === 0 ? 'case study' : 'survey', country: i === 0 ? 'Bangladesh' : 'India', quote: i === 0 ? 'This study finds that flow matters' : 'invented quote not in the text' })) };
      } else if (prompt.includes('FULL TEXT of')) out = { relevance: 5, findings: ['Full text finding.'], data_points: [], method: 'survey', sample: '', limitations: '', future_research: '', method_type: 'survey', country: '', quote: '' };
      else if (prompt.includes('most important CLAIMS')) out = { claims: [{ claim: 'Dams reduce dry-season flow.', support: [0, 1], contradict: [], note: '' }, { claim: 'Floods get worse.', support: [1], contradict: [0], note: 'Different periods' }] };
      else if (prompt.includes('RESEARCH GAPS')) out = { gaps: [{ title: 'Few dry-season studies', type: 'empirical', priority: 'high', description: 'Little evidence.', signal: '2 sources', evidence: [0], research_question: 'How does the dam change dry-season flow in Bangladesh?', method: 'Hydrological modelling' }] };
      else if (prompt.includes('EVIDENCE CARDS') || prompt.includes('Accepted findings with citation markers')) { const m = prompt.match(/\[src:\d+\]/); out = { text: 'Drafted paragraph one ' + (m ? m[0] : '') + ' and a fake one [src:999999].\n\nSecond paragraph.' }; }
      else out = {};
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
    }
    const isSearch = /api\.openalex\.org\/works\?|semanticscholar\.org\/graph\/v1\/paper\/search|api\.crossref\.org\/works\?|doaj\.org\/api|openlibrary\.org\/search|wikipedia\.org\/w\/api\.php/.test(u);
    if (failSearch && isSearch) return down();
    if (u.startsWith('https://api.openalex.org/works?')) {
      const q = new URL(u).searchParams.get('search') || 'x';
      return ok({ results: [1, 2, 3].map((i) => ({ id: 'https://openalex.org/W' + q.length + i, doi: 'https://doi.org/10.1000/' + q.length + '.' + i, display_name: 'Study ' + i + ' on ' + q, type: 'article', publication_year: 2018 + i, cited_by_count: 10 * i,
        authorships: [{ author: { display_name: 'Ann Author' + i } }], primary_location: { source: { display_name: i === 3 ? 'OMICS Journal of Water' : 'Journal of Water', type: 'journal' } }, abstract_inverted_index: abstract })) });
    }
    if (u.includes('semanticscholar.org/graph/v1/paper/search')) {
      const q = new URL(u).searchParams.get('query') || 'x';
      return ok({ data: [{ title: 'Study 1 on ' + q, abstract: 'This study finds that flow matters downstream. It also notes gaps in the record.', year: 2019, authors: [{ name: 'Ann Author1' }], venue: 'Journal of Water', externalIds: { DOI: '10.1000/' + q.length + '.1' }, citationCount: 12 }] });
    }
    if (u.includes('semanticscholar.org/graph/v1/paper/DOI:')) {
      const key = u.includes('/references') ? 'citedPaper' : 'citingPaper';
      return ok({ data: [{ [key]: { title: 'Trail paper ' + key, abstract: 'A trail paper about dams and river flow downstream in South Asia.', year: 2015, authors: [{ name: 'Tom Trail' }], venue: 'Water Policy', externalIds: { DOI: '10.2000/' + key }, citationCount: 99 } }] });
    }
    if (u.startsWith('https://api.crossref.org/works/')) return ok({ message: { publisher: 'Water Press', 'updated-by': /\.2$/.test(decodeURIComponent(u.split('?')[0])) ? [{ type: 'retraction' }] : [] } });
    if (u.startsWith('https://api.crossref.org/works?')) return ok({ message: { items: [] } });
    if (u.startsWith('https://doaj.org/api')) return ok({ results: [] });
    if (u.startsWith('https://openlibrary.org/search.json')) return ok({ docs: [{ key: '/works/OL1W', title: 'Rivers of Asia', author_name: ['Rita River'], first_publish_year: 2012, publisher: ['River Books'], subject: ['Rivers', 'Water'] }] });
    if (u.includes('wikipedia.org/w/api.php')) return ok({ query: { pages: { 1: { index: 1, title: 'Brahmaputra River', extract: 'The Brahmaputra is a trans-boundary river. It flows through Tibet, India and Bangladesh.', fullurl: 'https://en.wikipedia.org/wiki/Brahmaputra_River' } } } });
    return notFound(); // everything else (PDFs, other services) is unavailable in tests
  };
  return { calls, restore: () => { global.fetch = real; } };
}
const agentLib = require('../src/lib/agent');
function waitForRun() { return new Promise((resolve) => agentLib._onFinish(resolve)); }
const bin = (res, cb) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); };

test('AI agents: plan, search, evidence cards, agreement, gaps, select, accept, export, follow-up', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  process.env.GEMINI_API_KEY = 'test-key';
  const m = mockServices();
  try {
    assert.strictEqual((await leader.get('/topics/' + tid + '/agents')).status, 200);
    assert.strictEqual((await aisha.post('/topics/' + tid + '/agents/question').type('form').send({ _csrf: aisha.csrf, question: 'x' })).status, 403, 'only the owner plans');
    await leader.post('/topics/' + tid + '/agents/question').type('form').send({ _csrf: leader.csrf, question: 'How will the Medog dam affect downstream water security?', since: '2018' });
    assert.strictEqual((await db('topics').where({ id: tid }).first()).agent_since, '2018');
    await leader.post('/topics/' + tid + '/agents/suggest').type('form').send({ _csrf: leader.csrf });
    assert.ok(await db('parts').where({ topic_id: tid, title: 'Hydrology baseline', agent_name: 'Hydrology agent' }).first(), 'suggested parts added');
    await leader.post('/topics/' + tid + '/agents/parts').type('form').send({ _csrf: leader.csrf, title: 'Downstream flow', brief: 'How flow changes downstream', agent_name: 'Water agent',
      sources: ['openalex', 'semantic_scholar', 'crossref', 'openlibrary', 'wikipedia', 'nonsense'], depth: 'quick', lang: 'en', opts_present: '1', opts: ['trail', 'synthesis', 'gaps'] });
    const part = await db('parts').where({ topic_id: tid, title: 'Downstream flow' }).first();
    assert.strictEqual(part.agent_sources, 'openalex,semantic_scholar,crossref,openlibrary,wikipedia');
    assert.strictEqual(part.agent_options, 'trail,synthesis,gaps');
    const done = waitForRun();
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/launch').type('form').send({ _csrf: leader.csrf });
    await done;
    assert.strictEqual((await db('parts').where({ id: part.id }).first()).agent_status, 'review');
    const run = await db('agent_runs').where({ part_id: part.id }).orderBy('id', 'desc').first();
    assert.strictEqual(run.status, 'done', run.error || '');
    assert.match(run.model, /Gemini/);
    assert.strictEqual(JSON.parse(run.plan).questions.length, 3, 'part title + 2 planned sub-questions');
    const cards = (await db('agent_sources').where({ run_id: run.id })).map(agentLib.parseCard);
    assert.ok(cards.length >= 5, 'cards saved: ' + cards.length);
    assert.ok(cards.some((c) => c.type === 'reference' && c.tier === 'low'), 'Wikipedia card');
    assert.ok(cards.some((c) => c.type === 'book'), 'Open Library card');
    assert.ok(cards.some((c) => c.found_in.includes('openalex') && c.found_in.includes('semantic_scholar')), 'same paper from two databases merged');
    assert.ok(cards.some((c) => c.found_in.includes('citation_trail') && /Cite|Cited by/.test(c.via)), 'citation trail followed');
    assert.ok(cards.some((c) => c.flags.includes('retracted')), 'retraction found via Crossref');
    assert.ok(cards.some((c) => c.flags.includes('check_journal')), 'questionable journal flagged');
    const a = cards.find((c) => c.findings.includes('Finding A about flow.') && c.doi && c.type === 'paper' && !c.flags.length);
    assert.ok(a && a.data_points.length && a.method === 'case study' && a.quote && /\(Author1, 20\d\d\)/.test(a.in_text) && a.citation.includes('doi: 10.1000'), 'extracted card with verified quote and Harvard citation');
    assert.ok(cards.every((c) => c.quote !== 'invented quote not in the text'), 'invented quotes are dropped');
    assert.ok(JSON.parse(run.synthesis).length >= 1, 'agreement map saved');
    assert.match(run.gap_data, /Few dry-season studies/);
    assert.ok(m.calls.some((c) => c.includes('from_publication_date%3A2018-01-01') || c.includes('from_publication_date:2018-01-01')), 'year filter sent');
    assert.ok(await db('notifications').where({ user_id: ids.ehsan }).where('title', 'like', '%finished “Downstream flow”%').first());
    // Review page: tabs and cards; co-authors can read and comment, not select or accept
    const page = await aisha.get('/topics/' + tid + '/agents/' + part.id);
    assert.strictEqual(page.status, 200);
    for (const s of ['Finding A about flow', 'Agreement', 'Dams reduce dry-season flow', 'Few dry-season studies', 'Publications by year', 'RETRACTED']) assert.ok(page.text.includes(s), s);
    assert.strictEqual((await aisha.post('/topics/' + tid + '/agents/' + part.id + '/select').set('Accept', 'application/json').set('x-csrf-token', aisha.csrf).send({ ids: [a.id], selected: true })).status, 403);
    assert.strictEqual((await aisha.post('/topics/' + tid + '/agents/' + part.id + '/findings').type('form').send({ _csrf: aisha.csrf, action: 'accept', card: [a.id] })).status, 403);
    await aisha.post('/topics/' + tid + '/agents/' + part.id + '/comments').type('form').send({ _csrf: aisha.csrf, body: 'Check source 2' });
    assert.ok(await db('agent_comments').where({ part_id: part.id, body: 'Check source 2' }).first());
    // Selecting a card keeps its finding for the paper
    const sel = await leader.post('/topics/' + tid + '/agents/' + part.id + '/select').set('Accept', 'application/json').set('x-csrf-token', leader.csrf).send({ ids: [a.id], selected: true });
    assert.strictEqual(sel.body.selected, 1);
    assert.ok((await db('agent_findings').where({ source_id: a.id }).first()).kept);
    // Exports
    const pack = await leader.get('/topics/' + tid + '/agents/' + part.id + '/export/evidence.md');
    assert.match(pack.text, /# Evidence pack: Downstream flow/);
    assert.match(pack.text, /Finding A about flow/);
    for (const f of ['evidence.docx', 'matrix.xlsx', 'gaps.docx']) {
      const r = await leader.get('/topics/' + tid + '/agents/' + part.id + '/export/' + f).buffer(true).parse(bin);
      assert.strictEqual(r.status, 200, f);
      assert.strictEqual(r.body.slice(0, 2).toString(), 'PK', f);
    }
    // Gaps again from the selected card only
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/gaps').type('form').send({ _csrf: leader.csrf, scope: 'selected' });
    assert.strictEqual(JSON.parse((await db('agent_runs').where({ id: run.id }).first()).gap_data).scope, 'selected');
    // Accept with the card form
    const b = cards.find((c) => c.id !== a.id && !c.flags.length);
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/findings').type('form').send({ _csrf: leader.csrf, action: 'accept', cards_present: '1', card: [a.id, b.id] });
    assert.strictEqual((await db('parts').where({ id: part.id }).first()).agent_status, 'accepted');
    assert.strictEqual((await db('agent_findings').where({ run_id: run.id, kept: true })).length, 2);
    const st = await leader.get('/topics/' + tid + '/agents/status.json');
    assert.ok(st.body.parts.some((x) => x.id === part.id && x.status === 'accepted'));
    assert.match((await leader.get('/topics/' + tid + '/findings')).text, /Downstream flow/);
    // Follow-up runs again and keeps the history
    const again = waitForRun();
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/ask').type('form').send({ _csrf: leader.csrf, followup: 'Focus on Bangladesh' });
    await again;
    const runs = await db('agent_runs').where({ part_id: part.id });
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs.find((x) => x.followup).followup, 'Focus on Bangladesh');
    // accept the new run's best card too so the paper test has findings
    const newest = Math.max(...runs.map((x) => x.id));
    const nc = (await db('agent_sources').where({ run_id: newest })).map(agentLib.parseCard).filter((c) => c.findings.includes('Finding A about flow.'));
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/findings').type('form').send({ _csrf: leader.csrf, action: 'accept', cards_present: '1', card: nc.map((c) => c.id) });
  } finally { m.restore(); delete process.env.GEMINI_API_KEY; }
});

test('AI agents: work without an AI key, and report failures', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  delete process.env.GEMINI_API_KEY;
  let m = mockServices();
  try {
    assert.match((await leader.get('/topics/' + tid + '/agents')).text, /sources-only mode/);
    const part = await db('parts').where({ topic_id: tid, title: 'Treaties and law' }).first();
    const done = waitForRun();
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/launch').type('form').send({ _csrf: leader.csrf });
    await done;
    const run = await db('agent_runs').where({ part_id: part.id }).orderBy('id', 'desc').first();
    assert.strictEqual(run.status, 'done', run.error || '');
    assert.strictEqual(run.model, 'none');
    const cards = (await db('agent_sources').where({ run_id: run.id })).map(agentLib.parseCard);
    assert.ok(cards.length >= 3 && cards.some((c) => c.findings.length), 'cards with key sentences from abstracts');
    assert.ok(JSON.parse(run.gap_data).ai === false, 'count-based gaps without AI');
    assert.match((await leader.get('/topics/' + tid + '/agents/' + part.id)).text, /Basic mode/);
  } finally { m.restore(); }
  m = mockServices({ failSearch: true });
  try {
    const part = await db('parts').where({ topic_id: tid, title: 'Hydrology baseline' }).first();
    const done = waitForRun();
    await leader.post('/topics/' + tid + '/agents/' + part.id + '/launch').type('form').send({ _csrf: leader.csrf });
    await done;
    const p = await db('parts').where({ id: part.id }).first();
    assert.strictEqual(p.agent_status, 'failed');
    assert.match((await leader.get('/topics/' + tid + '/agents/' + part.id)).text, /This run stopped/);
    assert.match((await leader.get('/actions')).text, /Agent stopped/);
  } finally { m.restore(); }
});

test('final paper: sections, insert findings with citations, draft, Word export, final report', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  const page = await leader.get('/topics/' + tid + '/paper');
  assert.strictEqual(page.status, 200);
  const part = await db('parts').where({ topic_id: tid, title: 'Downstream flow' }).first();
  const sec = await db('paper_sections').where({ topic_id: tid, part_id: part.id }).first();
  assert.ok(sec, 'a section for each part');
  assert.ok(await db('paper_sections').where({ topic_id: tid, title: 'Introduction' }).first());
  const pg = await leader.get('/topics/' + tid + '/paper?s=' + sec.id);
  assert.match(pg.text, /Finding A about flow/);
  const f = await db('agent_findings').where({ part_id: part.id, kept: true }).orderBy('id', 'desc').first();
  assert.strictEqual((await aisha.post('/topics/' + tid + '/paper/sections/' + sec.id).type('form').send({ _csrf: aisha.csrf, action: 'insert', finding: f.id })).status, 403, 'co-authors suggest, the owner edits');
  await leader.post('/topics/' + tid + '/paper/sections/' + sec.id).type('form').send({ _csrf: leader.csrf, action: 'insert', finding: f.id });
  const body = (await db('paper_sections').where({ id: sec.id }).first()).body;
  assert.match(body, /\[src:\d+\]/);
  const view = await leader.get('/topics/' + tid + '/paper?s=' + sec.id);
  assert.match(view.text, /<sup class="ref">\[<a href="#ref1">1<\/a>/);
  assert.match(view.text, /Author1, A\./);
  // Draft from findings with AI: invented citation markers are removed
  process.env.GEMINI_API_KEY = 'test-key';
  const m = mockServices();
  try {
    await leader.post('/topics/' + tid + '/paper/sections/' + sec.id).type('form').send({ _csrf: leader.csrf, action: 'draft' });
  } finally { m.restore(); delete process.env.GEMINI_API_KEY; }
  const b2 = (await db('paper_sections').where({ id: sec.id }).first()).body;
  assert.match(b2, /Drafted paragraph one/);
  assert.doesNotMatch(b2, /src:999999/);
  // Co-author suggestion
  await aisha.post('/topics/' + tid + '/paper/sections/' + sec.id + '/comments').type('form').send({ _csrf: aisha.csrf, body: 'Shorten this' });
  assert.ok(await db('paper_comments').where({ section_id: sec.id, body: 'Shorten this' }).first());
  // Save edits
  await leader.post('/topics/' + tid + '/paper/sections/' + sec.id).type('form').send({ _csrf: leader.csrf, action: 'save', title: 'Downstream flow', body: b2 + '\n\nMy own words.' });
  // Word export and print view
  const doc = await leader.get('/topics/' + tid + '/paper.docx').buffer(true).parse((res, cb) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
  assert.strictEqual(doc.status, 200);
  assert.strictEqual(doc.body.slice(0, 2).toString(), 'PK');
  assert.match((await leader.get('/topics/' + tid + '/paper/print')).text, /References/);
  // Save as final report → file created and preselected on the finish page
  const fin = await leader.post('/topics/' + tid + '/paper/final').type('form').send({ _csrf: leader.csrf });
  assert.match(fin.headers.location, /\/finish\?file=\d+/);
  const fid = parseInt(fin.headers.location.match(/file=(\d+)/)[1], 10);
  assert.ok(await db('files').where({ id: fid, folder: 'Final report' }).first());
  assert.match((await leader.get(fin.headers.location.replace('#report', ''))).text, new RegExp('value="' + fid + '" checked'));
});

test('showcase: page download, publish toggle, website zip', async () => {
  const tid = await topicId('CT-0150');
  const leader = await agentFor('ehsan@ctent.demo');
  const aisha = await agentFor('aisha@ctent.demo');
  const view = await leader.get('/topics/' + tid + '/showcase.html?view=1');
  assert.strictEqual(view.status, 200);
  assert.match(view.text, /<!doctype html>/);
  assert.match(view.text, /References/);
  assert.doesNotMatch(view.text, /<script/i, 'plain HTML and CSS only');
  const dl = await leader.get('/topics/' + tid + '/showcase.html');
  assert.match(dl.headers['content-disposition'] || '', /attachment; filename="[a-z0-9-]+\.html"/);
  assert.strictEqual((await aisha.post('/topics/' + tid + '/showcase').type('form').send({ _csrf: aisha.csrf, action: 'publish' })).status, 403, 'only the leader publishes');
  await leader.post('/topics/' + tid + '/showcase').type('form').send({ _csrf: leader.csrf, action: 'publish' });
  assert.ok((await db('topics').where({ id: tid }).first()).showcase);
  const zip = await leader.get('/showcase.zip').buffer(true).parse((res, cb) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); });
  assert.strictEqual(zip.status, 200);
  assert.strictEqual(zip.body.slice(0, 2).toString(), 'PK');
  const JSZip = require('jszip');
  const files = Object.keys((await JSZip.loadAsync(zip.body)).files);
  assert.ok(files.includes('index.html') && files.includes('about.html') && files.some((f) => /^papers\/.+\.html$/.test(f)), files.join(','));
  assert.strictEqual((await aisha.get('/showcase.zip')).status, 403);
  await leader.post('/topics/' + tid + '/showcase').type('form').send({ _csrf: leader.csrf, action: 'unpublish' });
  assert.ok(!(await db('topics').where({ id: tid }).first()).showcase);
});

test('AI backup: Gemini busy falls back to Groq; extra sources are searched', async () => {
  const llm = require('../src/lib/llm');
  const research = require('../src/lib/research');
  process.env.GEMINI_API_KEY = 'g'; process.env.GROQ_API_KEY = 'q';
  const real = global.fetch;
  const ok = (obj, text) => ({ ok: true, status: 200, json: async () => obj, text: async () => text || JSON.stringify(obj) });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage')) return { ok: false, status: 429, json: async () => ({}), text: async () => 'quota' };
    if (u.includes('api.groq.com')) return ok({ choices: [{ message: { content: '{"answer":42}' } }] });
    if (u.includes('semanticscholar')) return ok({ data: [{ title: 'S2 paper', abstract: 'An abstract.', year: 2021, authors: [{ name: 'B. One' }], externalIds: { DOI: '10.1/s2' }, citationCount: 3 }] });
    if (u.includes('europepmc')) return ok({ resultList: { result: [{ title: 'PMC paper', abstractText: '<p>Health abstract.</p>', pubYear: '2020', authorString: 'C. Two.', doi: '10.1/pmc', source: 'MED', id: '1' }] } });
    if (u.includes('arxiv.org')) return ok(null, '<feed><entry><id>http://arxiv.org/abs/1</id><published>2022-01-01</published><title>Arxiv &amp; paper</title><summary>Preprint abstract.</summary><author><name>D. Three</name></author></entry></feed>');
    throw new Error('unexpected ' + u);
  };
  try {
    assert.deepStrictEqual(llm.providers().slice(0, 2), ['gemini', 'groq']);
    const out = await llm.json('sys', 'prompt');
    assert.strictEqual(out.answer, 42);
    assert.match(out._by, /Groq/);
    assert.strictEqual((await research.searchSemanticScholar('x', 5))[0].doi, '10.1/s2');
    assert.strictEqual((await research.searchEuropePmc('x', 5))[0].abstract, 'Health abstract.');
    const ax = await research.searchArxiv('x', 5);
    assert.strictEqual(ax[0].title, 'Arxiv & paper');
    assert.deepStrictEqual(ax[0].authors, ['D. Three']);
  } finally { global.fetch = real; delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY; }
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
