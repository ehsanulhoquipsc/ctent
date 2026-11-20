'use strict';
// Step 6 · Publish: the style library rules, the agent pipeline (with the AI replaced by a scripted stand-in that
// makes deliberate mistakes), the claims / numbers / copying checks, and who can do what.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const tmp = path.join(os.tmpdir(), 'ctent-pub-' + process.pid + '.sqlite');
process.env.SQLITE_FILE = tmp;
process.env.NODE_ENV = 'test';
process.env.GROQ_API_KEY = 'test-key';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;

const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');
const llm = require('../src/lib/llm');
const pub = require('../src/lib/publish');
let app, topic, leader, member, guest;

const SAMPLE = 'নদীর ধারে বসে থাকা মানুষটি জানত না আজ বিকেলে আকাশ কেমন রং নেবে, তবু সে প্রতিদিনের মতো অপেক্ষা করছিল। ' +
  'আমাদের জীবনও এমনই, আমরা জানি না সামনে কী আছে, তবু আমরা পথ চলি। গ্রামের মানুষেরা বলে, ধৈর্য ধরলে সব ঠিক হয়ে যায়। ' +
  'কিন্তু শহরের মানুষ ধৈর্য হারিয়েছে অনেক আগেই, তারা ছুটছে আর ছুটছে, থামার সময় নেই কারো।';
const COPIED = 'the river bank where the old man waited every single afternoon for the boats';
const SAMPLE_EN = 'He sat on ' + COPIED + ' to come home, and nobody asked him why. Days went by like water, slow and patient, and the village went on with its work.';

// The scripted AI. It answers by looking at what it was asked, and makes some mistakes on purpose.
const calls = [];
function fakeAI(system, prompt) {
  calls.push(system.slice(0, 40));
  if (/describe a writer/.test(system)) return { card: 'Warm and reflective. Opens with a scene from daily life. Short paragraphs. Ends with a question.', examples: ['নদীর ধারে বসে থাকা মানুষটি'] };
  if (/extract facts/.test(system)) return { facts: [
    { text: 'About 1,344 more people than expected died in Ahmedabad during the May 2010 heat wave.', ref: '' },
    { text: 'Ahmedabad adopted South Asia’s first heat action plan in 2013.', ref: '' },
    { text: 'The plan cut deaths by 9,999 people.', ref: '' } // not in the paper: must be dropped by the code
  ], main: ['Heat waves kill many people in cities.', 'Heat action plans reduce deaths.'] };
  if (/Facebook posts/.test(system)) return { text: '**আহমেদাবাদে** ২০১০ সালের মে মাসে প্রায় ১,৩৪৪ জন বেশি মানুষ মারা যান।\n\n## কী কাজ করে?\n\n২০১৩ সালে শহরটি হিট অ্যাকশন প্ল্যান চালু করে। দক্ষিণ এশিয়ার ৭৭৭টি শহর এখন প্রস্তুত।\n\nআমাদের শহর কি প্রস্তুত?\n\nতথ্যসূত্র: ভুল লাইন যা বাদ যাবে' };
  if (/covers a list of findings/.test(system)) return { missing: [] };
  if (/public website/.test(system)) {
    if (/Bangla/.test(system) && /চলিত/.test(system)) return { title: 'শহর যখন তপ্ত', subtitle: 'তাপ আর স্বাস্থ্য', body: '## শুরু\n\n২০১০ সালে আহমেদাবাদে প্রায় 1,344 জন বেশি মানুষ মারা যান [1].\n\n## কী কাজ করে\n\n২০১৩ সালে প্রথম হিট অ্যাকশন প্ল্যান চালু হয় [2].' };
    return { title: 'When the city overheats', subtitle: 'Heat and health in South Asia', body: '## A deadly May\n\nIn May 2010 about 1,344 more people died in Ahmedabad than expected.\n\n## What works\n\nIn 2013 the city adopted a heat action plan. Like ' + COPIED + ', the city waited.' };
  }
  if (/fact-check/.test(system)) {
    const first = (prompt.split('PIECE:\n')[1] || '').split(/(?<=[.।])\s+/).find((s) => /1,344|১,৩৪৪/.test(s));
    return { claims: first ? [{ quote: first.replace(/^\*\*|\*\*/g, '').trim(), status: 'ok', fact: 1 }] : [] };
  }
  if (/Rewrite ONE sentence/.test(system)) return { sentence: '২০১৩ সালে শহরটি দক্ষিণ এশিয়ার প্রথম হিট অ্যাকশন প্ল্যান চালু করে।' };
  if (/Rewrite this Bangla Facebook post/.test(system)) return { text: '২০১০ সালে আহমেদাবাদে প্রায় ১,৩৪৪ জন বেশি মানুষ মারা যান। ২০১৩ সালে প্ল্যান চালু হয়।' };
  if (/Rewrite this website article/.test(system)) return { body: '## Short\n\nIn May 2010 about 1,344 more people died in Ahmedabad than expected.' };
  return {};
}
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
async function signIn(email) {
  const a = request.agent(app);
  const pg = await a.get('/login');
  await a.post('/login').type('form').send({ _csrf: csrfOf(pg.text), email, password: 'demo1234' });
  a.csrf = csrfOf((await a.get('/profile')).text);
  return a;
}
async function waitRun(id) {
  for (let i = 0; i < 200; i++) { const r = await db('publish_runs').where({ id }).first(); if (['done', 'failed'].includes(r.status)) return r; await new Promise((s) => setTimeout(s, 25)); }
  throw new Error('run did not finish');
}

before(async () => {
  if (db.isPg) { await db.raw('drop schema public cascade'); await db.raw('create schema public'); }
  await db.migrate.latest();
  await seedDemo();
  llm.json = async (system, prompt) => ({ ...fakeAI(system, prompt), _by: 'Test AI' });
  app = createApp();
  const lead = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where({ 'topic_members.role': 'leader', 'users.platform_role': 'leader' }).select('topic_members.topic_id', 'users.email').first();
  topic = await db('topics').where({ id: lead.topic_id }).first();
  leader = lead.email;
  member = (await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where({ topic_id: topic.id, role: 'member' }).select('users.email').first()).email;
  const g = await db('topic_members').join('users', 'users.id', 'topic_members.user_id').where({ topic_id: topic.id, role: 'guest' }).select('users.email').first();
  guest = g ? g.email : null;
  // The final paper the public versions are made from.
  await db('paper_sections').where({ topic_id: topic.id }).del();
  await db('paper_sections').insert([
    { topic_id: topic.id, title: 'Introduction', position: 10, body: 'Extreme heat is a growing danger in South Asian cities.', updated_at: new Date().toISOString() },
    { topic_id: topic.id, title: 'Findings', position: 20, body: 'In May 2010 about 1,344 more people than expected died in Ahmedabad. In 2013 the city adopted South Asia’s first heat action plan.', updated_at: new Date().toISOString() }
  ]);
});
after(async () => { await db.destroy(); try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });

test('text helpers: Bangla digits (not in links), plain text for Facebook, numbers, copying, copyright years', () => {
  const t = pub._t;
  assert.equal(t.toBanglaDigits('2010 sale 1,344 jon · doctren.com/a1 · https://x.org/2020'), '২০১০ sale ১,৩৪৪ jon · doctren.com/a1 · https://x.org/2020');
  assert.equal(t.toLatinDigits('১,৩৪৪'), '1,344');
  assert.equal(t.plainText('**bold** text\n## Heading\n- item\n#হ্যাশট্যাগ'), 'bold text\nHeading\n• item\n#হ্যাশট্যাগ');
  const n = t.numbersIn('১. প্রথম কথা\n২০১০ সালে ১,৩৪৪ জন; 12.5% and 7 days');
  assert.deepEqual([...n].sort(), ['12.5', '1344', '2010']);
  assert.equal(t.copiedRuns('x ' + COPIED + ' y', [SAMPLE_EN]).length, 1);
  assert.equal(t.copiedRuns('a short line of only seven words here', [SAMPLE_EN]).length, 0);
  const year = new Date().getFullYear();
  assert.equal(pub.classicOk(1941), true); // Tagore
  assert.equal(pub.classicOk(1976), false); // Nazrul: still under copyright until 2037
  assert.equal(pub.classicOk(year - 61), true);
  assert.equal(pub.classicOk(year - 60), false);
});

test('style library: admins only; classic writers must be out of copyright; permission needs a file', async () => {
  const lead = await signIn(leader);
  assert.equal((await lead.get('/admin/styles')).status, 403);
  const admin = await signIn('nadia@ctent.demo');
  const page = await admin.get('/admin/styles');
  assert.equal(page.status, 200);
  assert.match(page.text, /Add a style/);
  const nazrul = await admin.post('/admin/styles').field('_csrf', admin.csrf).field('name', 'কাজী নজরুল ইসলাম').field('rights', 'classic').field('died_year', '1976').field('samples', SAMPLE);
  assert.equal(nazrul.status, 400);
  assert.match(nazrul.text, /more than 60 years ago/);
  const noFile = await admin.post('/admin/styles').field('_csrf', admin.csrf).field('name', 'ড. ফারহানা কবির').field('rights', 'permission').field('samples', SAMPLE);
  assert.equal(noFile.status, 400);
  assert.match(noFile.text, /Upload the writer’s written permission/);
  const tagore = await admin.post('/admin/styles').field('_csrf', admin.csrf).field('name', 'রবীন্দ্রনাথ ঠাকুর').field('rights', 'classic').field('died_year', '1941').field('samples', SAMPLE + '\n---\n' + SAMPLE_EN);
  assert.equal(tagore.status, 302);
  const s = await db('styles').where({ name: 'রবীন্দ্রনাথ ঠাকুর' }).first();
  assert.match(s.card, /Warm and reflective/);
  assert.equal(JSON.parse(s.samples).length, 2);
  const perm = await admin.post('/admin/styles').field('_csrf', admin.csrf).field('name', 'ড. ফারহানা কবির').field('rights', 'permission').field('samples', SAMPLE)
    .attach('proof', Buffer.from('I give permission. — F. Kabir'), { filename: 'permission.txt', contentType: 'text/plain' });
  assert.equal(perm.status, 302);
  const p = await db('styles').where({ name: 'ড. ফারহানা কবির' }).first();
  const proof = await admin.get('/admin/styles/' + p.id + '/proof');
  assert.equal(proof.status, 200);
  assert.match(proof.headers['content-disposition'], /attachment/);
  // Edit the style card
  const sp = await admin.get('/admin/styles/' + s.id);
  assert.match(sp.text, /Style card/);
  await admin.post('/admin/styles/' + s.id).type('form').send({ _csrf: csrfOf(sp.text), name: s.name, card: 'Lyrical and reflective, images from nature, ends on a thought.' });
  assert.match((await db('styles').where({ id: s.id }).first()).card, /Lyrical/);
});

test('publish run: Bangla Facebook post as a full, plain-text summary; English and Bangla articles; every claim checked', async () => {
  const style = await db('styles').where({ name: 'রবীন্দ্রনাথ ঠাকুর' }).first();
  const lead = await signIn(leader);
  const studio = await lead.get('/topics/' + topic.id + '/publish');
  assert.equal(studio.status, 200);
  assert.match(studio.text, /Write the public versions/);
  const go = await lead.post('/topics/' + topic.id + '/publish').type('form').send({ _csrf: csrfOf(studio.text), style_id: style.id, formats: ['fb', 'web_en', 'web_bn'], reader: 'public', length: 'full', link: 'doctren.com/heat', hashtags: 'তাপপ্রবাহ #জনস্বাস্থ্য' });
  assert.equal(go.status, 302);
  const run = await waitRun(Number(go.headers.location.match(/run=(\d+)/)[1]));
  assert.equal(run.status, 'done', run.error);
  // The made-up fact (9,999) never reached the fact sheet.
  const sheet = JSON.parse(run.facts);
  assert.equal(sheet.facts.length, 2);
  assert.ok(!sheet.facts.some((f) => /9,999/.test(f.text)));
  const outs = await db('publish_outputs').where({ run_id: run.id });
  assert.deepEqual(outs.map((o) => o.format).sort(), ['fb', 'web_bn', 'web_en']);
  const fb = outs.find((o) => o.format === 'fb');
  assert.doesNotMatch(fb.body, /\*\*|^##/m, 'no markdown in the Facebook post');
  assert.match(fb.body, /১,৩৪৪/);
  assert.doesNotMatch(fb.body, /ভুল লাইন/, 'the agent’s own sources line is replaced');
  assert.match(fb.body, /তথ্যসূত্র: চূড়ান্ত গবেষণা প্রতিবেদন। বিস্তারিত লেখা ও সব তথ্যসূত্র: doctren\.com\/heat\n#তাপপ্রবাহ #জনস্বাস্থ্য$/);
  const bn = outs.find((o) => o.format === 'web_bn');
  assert.match(bn.body, /১,৩৪৪/, 'Bangla digits in the Bangla article');
  assert.match(bn.body, /\[1\]/, 'citation numbers stay as they are');
  // Claims: the made-up number in the post and the copied words in the English article are caught.
  const fbClaims = await db('publish_claims').where({ output_id: fb.id });
  assert.ok(fbClaims.some((c) => c.status === 'ok'));
  const bad = fbClaims.find((c) => c.status === 'unsupported');
  assert.ok(bad, 'the number ৭৭৭ is flagged');
  assert.match(bad.quote, /৭৭৭/);
  const en = outs.find((o) => o.format === 'web_en');
  const copied = (await db('publish_claims').where({ output_id: en.id })).find((c) => c.status === 'copied');
  assert.ok(copied, 'words copied from the samples are flagged');
  // Studio shows the post, the warning count and the copy button.
  const page = await lead.get('/topics/' + topic.id + '/publish?run=' + run.id + '&tab=fb');
  assert.match(page.text, /Copy post/);
  assert.match(page.text, /claim needs you before copying/);
  assert.match(page.text, /Not in the paper/);
  // Fix the made-up number: the sentence is rewritten from the paper's facts and checked again.
  const fix = await lead.post('/topics/' + topic.id + '/publish/claims/' + bad.id).type('form').send({ _csrf: csrfOf(page.text), action: 'rewrite' });
  assert.equal(fix.status, 302);
  const fb2 = await db('publish_outputs').where({ id: fb.id }).first();
  assert.doesNotMatch(fb2.body, /৭৭৭/);
  assert.match(fb2.body, /দক্ষিণ এশিয়ার প্রথম হিট অ্যাকশন প্ল্যান/);
  assert.ok(!(await db('publish_claims').where({ output_id: fb.id })).some((c) => c.status === 'unsupported'));
  // Remove the copied words from the English article.
  await lead.post('/topics/' + topic.id + '/publish/claims/' + copied.id).type('form').send({ _csrf: csrfOf(page.text), action: 'remove' });
  assert.ok(!(await db('publish_outputs').where({ id: en.id }).first()).body.toLowerCase().includes(COPIED.slice(0, 30)));
  // Hand edit: a new number that isn't in the paper is caught at once.
  await lead.post('/topics/' + topic.id + '/publish/outputs/' + fb.id).type('form').send({ _csrf: csrfOf(page.text), body: fb2.body + '\nআরও ৫৫৫ জন আক্রান্ত।' });
  assert.ok((await db('publish_claims').where({ output_id: fb.id })).some((c) => c.status === 'unsupported' && /৫৫৫/.test(c.quote)));
  // Shorter keeps the sources line.
  await lead.post('/topics/' + topic.id + '/publish/outputs/' + fb.id + '/revise').type('form').send({ _csrf: csrfOf(page.text), how: 'shorter' });
  const fb3 = await db('publish_outputs').where({ id: fb.id }).first();
  assert.match(fb3.body, /^২০১০ সালে[\s\S]*তথ্যসূত্র:/);
  // Website article as Word.
  const word = await lead.get('/topics/' + topic.id + '/publish/outputs/' + en.id + '/word');
  assert.equal(word.status, 200);
  assert.match(word.headers['content-type'], /wordprocessingml/);
  // Copy as HTML carries headings.
  const enPage = await lead.get('/topics/' + topic.id + '/publish?run=' + run.id + '&tab=web_en');
  assert.match(enPage.text, /&lt;h2&gt;A deadly May&lt;\/h2&gt;/);
});

test('members can read but not write; guests can’t open Publish; no AI or no paper stops a run', async () => {
  const m = await signIn(member);
  const page = await m.get('/topics/' + topic.id + '/publish');
  assert.equal(page.status, 200);
  assert.match(page.text, /The project leader makes the public versions/);
  assert.doesNotMatch(page.text, /Write the public versions/);
  const style = await db('styles').first();
  const post = await m.post('/topics/' + topic.id + '/publish').type('form').send({ _csrf: csrfOf(page.text), style_id: style.id, formats: ['fb'] });
  assert.equal(post.status, 403);
  if (guest) assert.equal((await (await signIn(guest)).get('/topics/' + topic.id + '/publish')).status, 403);
  // Without an AI service the run is refused with a clear message.
  const key = process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY;
  const lead = await signIn(leader);
  const before = Number((await db('publish_runs').count({ n: '*' }).first()).n);
  await lead.post('/topics/' + topic.id + '/publish').type('form').send({ _csrf: lead.csrf, style_id: style.id, formats: ['fb'] });
  assert.equal(Number((await db('publish_runs').count({ n: '*' }).first()).n), before);
  process.env.GROQ_API_KEY = key;
  // A completed project points its leader to Publish.
  await db('topics').where({ id: topic.id }).update({ status: 'completed' });
  assert.match((await lead.get('/topics/' + topic.id)).text, /Open Publish/);
  await db('topics').where({ id: topic.id }).update({ status: 'active' });
  // A restart stops runs that were in the middle.
  const id = await db.insertId('publish_runs', { topic_id: topic.id, style_id: style.id, style_name: style.name, settings: '{}', status: 'running', progress: 40, created_at: new Date().toISOString() });
  await pub.recover();
  assert.equal((await db('publish_runs').where({ id }).first()).status, 'failed');
});
