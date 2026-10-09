'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');
const { todayStr } = require('./lib/util');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

const iso = (days, hour, minute) => {
  const d = new Date(Date.now() + days * 86400000);
  if (hour !== undefined) d.setUTCHours(hour, minute || 0, 0, 0);
  return d.toISOString();
};

async function seedDemo() {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const U = [
    ['Nadia Karim', 'nadia@ctent.demo', 'admin', 'CTENT', 'Platform administrator', 'burgundy'],
    ['Ehsan Hoque', 'ehsan@ctent.demo', 'leader', "King's Own Institute", 'Research lead', 'burgundy'],
    ['Dr. James Chen', 'james@ctent.demo', 'leader', 'UNSW Sydney', 'Senior lecturer · research ethics', 'green'],
    ['Aisha Rahman', 'aisha@ctent.demo', 'member', 'University of Sydney', 'PhD candidate · water security', 'indigo'],
    ['Priya Nair', 'priya@ctent.demo', 'member', 'Macquarie University', 'Research assistant · survey design', 'amber'],
    ['Tom Walker', 'tom@ctent.demo', 'member', 'UTS', 'Data analyst', 'teal'],
    ['Sara Malik', 'sara@ctent.demo', 'member', 'BRAC University', 'Field researcher', 'violet'],
    ['Rahul Mehta', 'rahul@ctent.demo', 'member', 'IIT Delhi (visiting)', 'Hydrology & remote sensing', 'burgundy'],
    ['Dr. Lin Wei', 'lin@ctent.demo', 'guest', 'National University of Singapore', 'External reviewer', 'violet']
  ];
  const id = {};
  for (const [name, email, role, inst, title, color] of U) {
    id[email.split('@')[0]] = await db.insertId('users', { name, email, password_hash: hash, platform_role: role, institution: inst, title, color, created_at: iso(-60) });
  }

  const EXP = {
    ehsan: [['Climate migration', 5], ['Mixed methods', 4], ['Project management', 4], ['South Asian politics', 3]],
    james: [['Research ethics', 5], ['Qualitative methods', 5], ['Environmental policy', 4], ['Chinese water policy', 4]],
    aisha: [['Water security', 5], ['South Asian politics', 4], ['GIS & remote sensing', 3], ['Policy analysis', 4], ['Bengali', 5]],
    priya: [['Survey design', 5], ['Sampling', 4], ['Statistics', 3], ['Interviews', 4]],
    tom: [['Statistics', 5], ['Data cleaning', 5], ['Python', 4], ['Literature review', 3]],
    sara: [['Interviews', 5], ['Fieldwork', 5], ['Bengali', 5], ['Transcription', 4]],
    rahul: [['Hydrology', 5], ['GIS & remote sensing', 4], ['Flood modelling', 4], ['Python', 4]],
    lin: [['Chinese water policy', 5], ['International relations', 4]]
  };
  for (const [k, list] of Object.entries(EXP)) {
    await db('expertise').insert(list.map(([name, level]) => ({ user_id: id[k], kind: 'field', name, level })));
  }

  const T = {};
  T.mig = await db.insertId('topics', { code: 'CT-0142', title: 'Climate-induced migration in coastal Bangladesh', description: 'Mixed-methods study of migration from coastal districts to Dhaka and Chattogram, linking salinity and cyclone exposure to household decisions.', field: 'Environmental science', status: 'active', color: 'burgundy', due_date: todayStr(140), created_by: id.ehsan, created_at: iso(-50) });
  T.dam = await db.insertId('topics', { code: 'CT-0150', title: 'How China’s Medog dam affects the geopolitics of Asia', description: 'Upstream dam on the Yarlung Tsangpo, which becomes the Brahmaputra in India and Bangladesh. Who gains leverage, and what happens downstream?', field: 'Geopolitics', status: 'active', color: 'teal', due_date: todayStr(110), created_by: id.ehsan, created_at: iso(-20) });
  T.zka = await db.insertId('topics', { code: 'CT-0131', title: 'Zero-knowledge authentication for research data', description: 'Evaluating privacy-preserving login for sensitive research datasets under GDPR and the Australian Privacy Principles.', field: 'Computer science', status: 'review', color: 'indigo', due_date: todayStr(20), created_by: id.james, created_at: iso(-90) });

  const M = [
    [T.mig, 'ehsan', 'leader'], [T.mig, 'james', 'member'], [T.mig, 'aisha', 'member'], [T.mig, 'priya', 'member'], [T.mig, 'tom', 'member'], [T.mig, 'sara', 'member'], [T.mig, 'lin', 'guest'],
    [T.dam, 'ehsan', 'leader'], [T.dam, 'aisha', 'member'], [T.dam, 'tom', 'member'], [T.dam, 'james', 'member'],
    [T.zka, 'james', 'leader'], [T.zka, 'priya', 'member'], [T.zka, 'tom', 'member'], [T.zka, 'lin', 'guest']
  ];
  await db('topic_members').insert(M.map(([topic_id, u, role]) => ({ topic_id, user_id: id[u], role, joined_at: iso(-40) })));
  await db('join_requests').insert({ topic_id: T.dam, user_id: id.rahul, message: 'My hydrology work on the Brahmaputra could cover flow and flood modelling.', status: 'pending', created_at: iso(-0.2) });

  // Plan & assign
  const P = [
    [T.dam, 'Upstream: China’s hydropower strategy', 'Policy documents, State Council plans and dam specifications.', 'Chinese water policy, Policy analysis', 'james', 'approved', 30],
    [T.dam, 'Downstream water security — India & Bangladesh', 'Dry-season flow, flood risk and agriculture downstream.', 'Water security, South Asian politics', 'aisha', 'approved', 35],
    [T.dam, 'Flow & flood modelling', 'Model dry-season flow change and flood peaks under dam operation scenarios.', 'Hydrology, Flood modelling, GIS & remote sensing', null, 'open', 45],
    [T.dam, 'Literature map — dam diplomacy', 'Group sources into strands and find gaps.', 'Literature review', 'tom', 'open', 21],
    [T.mig, 'Household survey — wave 2', 'Sampling frame, enumerator training and data collection in Khulna & Satkhira.', 'Survey design, Sampling, Fieldwork', 'priya', 'approved', 20],
    [T.mig, 'Key informant interviews', '30 interviews with local officials and NGO staff.', 'Interviews, Bengali', 'sara', 'approved', 25]
  ];
  const part = {};
  for (const [topic_id, title, description, skills, who, st, due] of P) {
    part[title] = await db.insertId('parts', { topic_id, title, description, skills, proposed_user_id: who ? id[who] : null, status: st, approved_by: st === 'approved' ? id.ehsan : null, due_date: todayStr(due), created_at: iso(-10) });
  }

  // Board
  const K = [
    [T.mig, 'Finalise sampling frame v2', 'priya', 'review', 1, 'high'], [T.mig, 'Train enumerators — Satkhira', 'sara', 'doing', 4, 'normal'],
    [T.mig, 'Clean wave 1 dataset', 'tom', 'done', -3, 'normal'], [T.mig, 'Translate interview guide to Bengali', 'sara', 'done', -6, 'normal'],
    [T.mig, 'Ethics amendment: add Khulna district', 'james', 'doing', 2, 'high'], [T.mig, 'Salinity exposure index by upazila', 'aisha', 'todo', 9, 'normal'],
    [T.mig, 'Book field transport', 'ehsan', 'todo', 6, 'low'], [T.mig, 'Draft methods chapter', 'ehsan', 'todo', 21, 'normal'],
    [T.mig, 'Wave 1 descriptive tables', 'tom', 'review', 3, 'normal'], [T.mig, 'Collect district boundaries (GeoJSON)', 'aisha', 'done', -10, 'low'],
    [T.dam, 'Collect Brahmaputra flow data 2015–2025', 'aisha', 'done', -2, 'high'], [T.dam, 'Downstream section draft v1', 'aisha', 'doing', 5, 'high'],
    [T.dam, 'Translate State Council hydropower plan', 'james', 'doing', 8, 'normal'], [T.dam, 'Literature map — first pass', 'tom', 'review', 2, 'normal'],
    [T.dam, 'Request Assam flood gauge data', null, 'todo', 7, 'normal'], [T.dam, 'Scenario list for dam operation', 'ehsan', 'todo', 12, 'normal'],
    [T.zka, 'Threat model write-up', 'tom', 'done', -12, 'normal'], [T.zka, 'Prototype ZK login demo', 'tom', 'done', -5, 'high'], [T.zka, 'Final report — privacy section', 'priya', 'review', 1, 'high']
  ];
  const PART_OF = {
    'Finalise sampling frame v2': 'Household survey — wave 2', 'Train enumerators — Satkhira': 'Household survey — wave 2',
    'Translate interview guide to Bengali': 'Key informant interviews', 'Collect Brahmaputra flow data 2015–2025': 'Downstream water security — India & Bangladesh',
    'Downstream section draft v1': 'Downstream water security — India & Bangladesh', 'Translate State Council hydropower plan': 'Upstream: China’s hydropower strategy'
  };
  for (const [topic_id, title, who, st, due, priority] of K) {
    const done = st === 'done';
    await db('tasks').insert({ topic_id, part_id: part[PART_OF[title]] || null, title, assignee_id: who ? id[who] : null, status: st, priority, due_date: todayStr(due), created_by: id.ehsan, completed_at: done ? iso(due) : null, created_at: iso(-30 + Math.abs(due)), updated_at: iso(-1) });
  }
  // History of completed tasks across recent weeks for the growth chart
  const HIST = ['Pilot survey in Khulna', 'Code pilot responses', 'Draft consent form', 'Map coastal upazilas', 'Summarise IPCC AR6 chapter', 'Set up Zotero group library', 'Clean pilot dataset', 'Write data management plan', 'Interview NGO staff — Satkhira', 'Translate consent form', 'Literature search — dam diplomacy', 'Collect Assam flood reports', 'Threat model review', 'Benchmark login latency', 'Draft research questions', 'Weekly progress note', 'Enumerator handbook', 'Annotate key sources', 'Check survey skip logic', 'Prepare ethics response', 'Codebook v1', 'Field budget sheet', 'Stakeholder list', 'Abstract draft for conference', 'Review related ZK schemes', 'Proofread chapter 1', 'GIS layer clean-up', 'Interview transcripts batch 1']; 
  for (let w = 1; w <= 7; w++) {
    const n = [2, 3, 2, 4, 3, 5, 4][w - 1];
    for (let i = 0; i < n; i++) {
      await db('tasks').insert({ topic_id: [T.mig, T.dam, T.zka][i % 3], title: HIST[(w * 5 + i) % HIST.length], assignee_id: id[['aisha', 'tom', 'priya', 'sara'][i % 4]], status: 'done', priority: 'normal', due_date: todayStr(-7 * w), created_by: id.ehsan, completed_at: iso(-7 * w + 1), created_at: iso(-7 * w - 5), updated_at: iso(-7 * w + 1) });
    }
  }

  // Channels & messages
  const ch = {};
  for (const [key, topic, name, purpose] of [['mg', T.mig, 'general', 'Everything about CT-0142'], ['mm', T.mig, 'methods', 'Research design, sampling and instruments'], ['dg', T.dam, 'general', 'Everything about CT-0150'], ['dd', T.dam, 'downstream', 'India & Bangladesh impacts'], ['zg', T.zka, 'general', 'Everything about CT-0131']]) {
    ch[key] = await db.insertId('channels', { topic_id: topic, name, kind: 'topic', purpose, created_by: id.ehsan, created_at: iso(-30) });
  }
  ch.room = await db.insertId('channels', { topic_id: null, name: 'phd-writing-group', kind: 'room', purpose: 'Weekly writing accountability', created_by: id.aisha, created_at: iso(-15) });
  await db('channel_members').insert(['aisha', 'priya', 'tom', 'ehsan'].map((u) => ({ channel_id: ch.room, user_id: id[u] })));
  const MSG = [
    ['mm', 'james', 'Before Thursday, can everyone review the revised sampling frame? I’ve added district-level quotas for wave 2.', -1.2],
    ['mm', 'aisha', 'Looks good. @Ehsan should we drop Bhola district given the access issues during the monsoon?', -1.1],
    ['mm', 'ehsan', 'Yes — let’s replace Bhola with Patuakhali for wave 2. I’ll log it as a decision.', -1.0],
    ['mm', 'priya', 'I’ll update the interview schedule and upload it to Submissions tonight.', -0.9],
    ['mg', 'ehsan', 'Welcome to CT-0142, everyone. Plan & assign is up to date — check your parts.', -6],
    ['mg', 'sara', 'Enumerator training in Satkhira is confirmed for next week.', -0.3],
    ['dd', 'aisha', 'Flow data for 2015–2025 is in Files → Data. Dry-season drop is clear after 2019.', -0.5],
    ['dd', 'tom', 'Nice. I’ll add it to the literature map as evidence for the downstream strand.', -0.4],
    ['dg', 'ehsan', 'Rahul Mehta asked to join — his hydrology skills fit the flood modelling part.', -0.15],
    ['zg', 'james', 'Final report is in review. Dr. Lin Wei will score it as our external reviewer.', -2],
    ['room', 'priya', 'Writing sprint tomorrow 9–11am? Library level 4.', -0.6],
    ['room', 'aisha', 'I’m in. Aiming for 1,500 words on the downstream chapter.', -0.55]
  ];
  for (const [c, u, body, d] of MSG) await db('messages').insert({ channel_id: ch[c], user_id: id[u], body, created_at: iso(d) });

  // Meetings
  await db('meetings').insert([
    { topic_id: T.mig, title: 'Weekly sync — methods review', starts_at: iso(1, 9), duration_min: 60, link: 'https://meet.google.com/abc-defg-hij', platform: 'Google Meet', agenda: 'Sampling frame v2 · ethics amendment · field transport', created_by: id.ehsan, created_at: iso(-3) },
    { topic_id: T.dam, title: 'Downstream water security check-in', starts_at: iso(3, 5), duration_min: 45, link: 'https://zoom.us/j/81234567890', platform: 'Zoom', agenda: 'Brahmaputra data-sharing, Assam flood risk, Bangladesh dry-season flow', created_by: id.ehsan, created_at: iso(-2) },
    { topic_id: T.mig, title: 'Wave 1 results walkthrough', starts_at: iso(-4, 6), duration_min: 60, link: 'https://teams.microsoft.com/l/meetup-join/demo', platform: 'Microsoft Teams', agenda: 'Descriptive tables, early patterns', minutes: 'Agreed to replace Bhola with Patuakhali. Tom to finish descriptive tables. Priya to revise sampling frame.', created_by: id.ehsan, created_at: iso(-9) }
  ]);

  // Files (small real files so downloads work)
  const file = async (topic, name, folder, mime, text, who, d) => db.insertId('files', { topic_id: topic, name, folder, mime, size: Buffer.byteLength(text), data: Buffer.from(text), uploaded_by: id[who], created_at: iso(d) });
  const csv = 'district,households,surveyed\nKhulna,420,412\nSatkhira,380,371\nPatuakhali,440,0\n';
  const f1 = await file(T.mig, 'sampling_frame_v2.csv', 'Data', 'text/csv', csv, 'priya', -1);
  const f0 = await file(T.mig, 'sampling_frame_v1.csv', 'Data', 'text/csv', 'district,households\nKhulna,420\nSatkhira,380\nBhola,400\n', 'priya', -9);
  const f2 = await file(T.mig, 'interview_guide_bn.txt', 'Instruments', 'text/plain', 'Interview guide (Bengali / English)\n1. When did your household first consider moving?\n2. What changed in the land or water?\n', 'sara', -6);
  await file(T.mig, 'ethics_approval_HREC-2026-118.txt', 'Ethics', 'text/plain', 'Ethics approval HREC-2026-118 — approved for Khulna and Satkhira. Amendment pending for Patuakhali.\n', 'james', -30);
  const f3 = await file(T.dam, 'brahmaputra_flow_2015_2025.csv', 'Data', 'text/csv', 'year,dry_season_flow_m3s\n2015,4210\n2017,4105\n2019,3890\n2021,3620\n2023,3480\n2025,3310\n', 'aisha', -2);
  const f4 = await file(T.dam, 'literature_map_v1.txt', 'Literature', 'text/plain', 'Strands: hydro-hegemony; data-sharing agreements; security framing; downstream livelihoods.\n', 'tom', -1);
  const f5 = await file(T.zka, 'final_report_privacy_section.txt', 'Reports', 'text/plain', 'Privacy section draft: zero-knowledge proofs allow verification without revealing credentials...\n', 'priya', -1);

  // Submissions
  const sub = async (topic, title, milestone, who, st, versions, d) => {
    const sid = await db.insertId('submissions', { topic_id: topic, title, milestone, created_by: id[who], reviewer_id: null, status: st, created_at: iso(d), updated_at: iso(d) });
    let v = 1;
    for (const fid of versions) await db('submission_versions').insert({ submission_id: sid, version: v++, file_id: fid, note: v === 2 ? 'First version' : 'Revised after feedback', created_by: id[who], created_at: iso(d) });
    return sid;
  };
  const s1 = await sub(T.mig, 'Sampling frame', 'Data collection', 'priya', 'in_review', [f0, f1], -1);
  await db('reviews').insert({ submission_id: s1, reviewer_id: id.ehsan, decision: 'changes', comment: 'Replace Bhola with Patuakhali and add the quotas per district.', created_at: iso(-5) });
  const s2 = await sub(T.mig, 'Interview guide (Bengali)', 'Instruments', 'sara', 'approved', [f2], -6);
  await db('reviews').insert({ submission_id: s2, reviewer_id: id.james, decision: 'approved', comment: 'Clear and culturally appropriate. Approved.', created_at: iso(-5) });
  await sub(T.dam, 'Brahmaputra flow dataset', 'Data', 'aisha', 'in_review', [f3], -2);
  await sub(T.dam, 'Literature map — dam diplomacy', 'Literature', 'tom', 'in_review', [f4], -1);
  await sub(T.zka, 'Final report — privacy section', 'Final report', 'priya', 'in_review', [f5], -1);

  // Notifications
  const N = [
    ['ehsan', 'review', 'Priya Nair submitted “Sampling frame” v2', 'Review it before Thursday’s sync.', '/topics/' + T.mig + '/submissions'],
    ['ehsan', 'request', 'Rahul Mehta asked to join CT-0150', 'Hydrology & flood modelling.', '/actions'],
    ['ehsan', 'mention', 'Aisha Rahman mentioned you in #methods', 'Should we drop Bhola district…', '/messages/' + ch.mm],
    ['aisha', 'task', 'Part approved: Downstream water security', 'You own this part in CT-0150.', '/topics/' + T.dam + '/plan'],
    ['aisha', 'meeting', 'Meeting in 3 days: Downstream water security check-in', 'Zoom', '/meetings'],
    ['priya', 'review', 'Changes requested on “Sampling frame”', 'Replace Bhola with Patuakhali…', '/topics/' + T.mig + '/submissions'],
    ['james', 'review', 'Final report — privacy section is waiting for review', '', '/topics/' + T.zka + '/submissions'],
    ['lin', 'review', 'You were invited to review CT-0131', 'Read-only access to submissions and files.', '/topics/' + T.zka]
  ];
  await db('notifications').insert(N.map(([u, kind, title, body, link], i) => ({ user_id: id[u], kind, title, body, link, created_at: iso(-i * 0.1) })));

  // Activity
  const A = [
    ['ehsan', T.mig, 'topic.created', 'Created topic CT-0142', -50], ['ehsan', T.dam, 'topic.created', 'Created topic CT-0150', -20],
    ['ehsan', T.dam, 'part.approved', 'Approved Aisha Rahman for “Downstream water security — India & Bangladesh”', -9],
    ['tom', T.mig, 'task.moved', 'Moved “Clean wave 1 dataset” to Done', -3], ['priya', T.mig, 'submission.version', 'Uploaded v2 of “Sampling frame”', -1],
    ['aisha', T.dam, 'file.uploaded', 'Uploaded brahmaputra_flow_2015_2025.csv', -2], ['nadia', null, 'user.role', 'Set Ehsan Hoque’s platform role to Leader', -45]
  ];
  for (const [u, t, action, detail, d] of A) await db('audit_log').insert({ user_id: id[u], topic_id: t, action, detail, created_at: iso(d) });
  return id;
}

async function ensureSeeded() {
  const row = await db('users').count({ n: '*' }).first();
  if (Number(row.n) === 0 && process.env.SEED_DEMO !== 'false') {
    await seedDemo();
    return true;
  }
  return false;
}

module.exports = { seedDemo, ensureSeeded, DEMO_PASSWORD };
