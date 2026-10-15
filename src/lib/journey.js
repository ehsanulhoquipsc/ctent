'use strict';
// The project journey: from a question to a finished paper, and the one next step to take.
// Agent mode (5 steps): Question → Research → Review → Write → Finish
// Manual mode (6 steps): Question → Assign → Research → Review work → Write → Finish
// A part is handled either by an agent (agent_status) or by a person (the part's linked task).
const db = require('../db');

const STEPS = [
  { key: 'question', label: 'Question', hint: 'Ask it and split it into parts' },
  { key: 'research', label: 'Research', hint: 'Agents find the evidence' },
  { key: 'review', label: 'Review', hint: 'Pick the evidence to use' },
  { key: 'write', label: 'Write', hint: 'Draft the paper' },
  { key: 'finish', label: 'Finish', hint: 'Final report & showcase' }
];
const MANUAL_STEPS = [
  { key: 'question', label: 'Question', hint: 'Ask it and split it into parts' },
  { key: 'assign', label: 'Assign', hint: 'Give each part to a person' },
  { key: 'research', label: 'Research', hint: 'Your team does the work' },
  { key: 'review', label: 'Review work', hint: 'Check each part' },
  { key: 'write', label: 'Write', hint: 'Draft the paper' },
  { key: 'finish', label: 'Finish', hint: 'Final report & showcase' }
];

// One status for every part, whoever handles it: draft | queued | running | review | accepted | failed
function partState(p, task) {
  if (p.handler !== 'person') return p.agent_status;
  if (!task) return 'draft';
  return { todo: 'running', doing: 'running', changes: 'running', review: 'review', done: 'accepted' }[task.status] || 'running';
}

function compute(topic, role, parts, sections, tasks) {
  const base = '/topics/' + topic.id;
  const leader = role === 'leader';
  const manual = topic.mode === 'manual';
  const taskOf = (p) => tasks.filter((t) => t.part_id === p.id).sort((a, b) => b.id - a.id)[0] || null;
  parts = parts.map((p) => ({ ...p, task: taskOf(p), state: partState(p, taskOf(p)) }));
  const n = parts.length;
  const count = (keys) => parts.filter((p) => keys.includes(p.state)).length;
  const researched = count(['review', 'accepted']);
  const accepted = count(['accepted']);
  const working = count(['queued', 'running']);
  const agentWaiting = parts.filter((p) => p.handler !== 'person' && ['draft', 'failed'].includes(p.state)).length;
  const unassigned = parts.filter((p) => p.handler === 'person' && !p.task).length;
  const waiting = agentWaiting + unassigned;
  const toReview = parts.find((p) => p.state === 'review');
  const filled = sections.filter((s) => String(s.body || '').trim()).length;
  const completed = topic.status === 'completed';
  const done = {
    question: !!topic.question && n > 0,
    assign: n > 0 && unassigned === 0,
    research: n > 0 && researched === n,
    review: n > 0 && accepted === n,
    write: completed || (sections.length > 0 && filled === sections.length),
    finish: completed
  };
  const detail = {
    question: !topic.question ? 'No question yet' : n ? n + ' part' + (n === 1 ? '' : 's') : 'Not split into parts yet',
    assign: !n ? 'Waiting for parts' : unassigned ? unassigned + ' part' + (unassigned === 1 ? '' : 's') + ' not assigned' : 'Everyone has a part',
    research: !n ? 'Waiting for parts' : working ? working + ' part' + (working === 1 ? '' : 's') + ' in progress' : researched + ' of ' + n + ' researched',
    review: !n ? 'Nothing to review yet' : accepted + ' of ' + n + ' accepted',
    write: sections.length ? filled + ' of ' + sections.length + ' sections written' : 'Not started',
    finish: completed ? 'Done' : 'Not finished'
  };
  const reviewHref = (p) => (p.handler === 'person' && p.task ? base + '/tasks/' + p.task.id + '#review' : base + '/agents/' + p.id);
  const href = { question: base + '/agents#question', assign: base + '/agents#parts', research: base + '/agents', review: toReview ? reviewHref(toReview) : base + '/agents', write: base + '/paper', finish: base + '/finish' };
  const LIST = manual ? MANUAL_STEPS : STEPS;
  const currentIdx = completed ? LIST.length : LIST.findIndex((s) => !done[s.key]);
  const steps = LIST.map((s, i) => ({ ...s, n: i + 1, done: done[s.key], current: i === currentIdx, detail: detail[s.key], href: href[s.key] }));
  const cur = steps[currentIdx] || null;

  // The one thing to do next.
  let next;
  const launch = (k) => 'Launch ' + (k === 1 ? 'the agent' : 'all ' + k + ' agents');
  if (completed) next = { title: 'Project complete', text: 'The final report is saved with the project. Share it on the showcase website.', label: 'Open final report', href: base + '/finish' };
  else if (topic.status === 'archived') next = { title: 'This project is archived', text: 'It’s read-only. Reopen it from Settings to keep working.', label: 'Open settings', href: base + '/settings' };
  else if (!topic.question) next = { title: 'Write your research question', text: 'Every part works from it. One or two sentences is enough.', label: 'Write the question', href: base + '/agents#question' };
  else if (!n) next = manual
    ? { title: 'Split the question into parts', text: 'Each part goes to one person on your team. Add the parts, then assign them.', label: 'Plan the parts', href: base + '/agents#parts' }
    : { title: 'Split the question into parts', text: 'Each part gets its own research agent. Let the AI suggest parts, or add your own.', label: 'Plan the parts', href: base + '/agents#parts' };
  else if (unassigned) next = { title: 'Assign the parts', text: unassigned + ' part' + (unassigned === 1 ? ' needs' : 's need') + ' a person and a due date. They’ll get a task and a notification.', label: 'Assign parts', href: base + '/agents#parts' };
  else if (agentWaiting && !working && researched < n) next = { title: 'Launch the agents', text: agentWaiting + ' agent' + (agentWaiting === 1 ? ' is' : 's are') + ' ready. They search papers, books and reports and come back with evidence cards.', label: launch(agentWaiting), action: base + '/agents/launch-all' };
  else if (toReview) next = toReview.handler === 'person'
    ? { title: 'Review the work on “' + toReview.title + '”', text: 'It was handed in for review. Approve it or ask for changes.', label: 'Review work', href: reviewHref(toReview) }
    : { title: 'Review the evidence for “' + toReview.title + '”', text: 'Tick the evidence cards you want in the paper, then accept them.', label: 'Review evidence', href: reviewHref(toReview) };
  else if (working) next = manual
    ? { title: 'Your team is working', text: working + ' of ' + n + ' parts in progress. You’ll get a notification when work is handed in.', label: 'See progress', href: base + '/agents' }
    : { title: 'The agents are researching', text: working + ' of ' + n + ' still working. You’ll get a notification as each one finishes — you can leave the page.', label: 'Watch progress', href: base + '/agents' };
  else if (agentWaiting) next = { title: 'Launch the remaining agents', text: agentWaiting + ' part' + (agentWaiting === 1 ? ' still needs' : 's still need') + ' research.', label: launch(agentWaiting), action: base + '/agents/launch-all' };
  else if (!done.write) {
    const empty = sections.find((s) => !String(s.body || '').trim());
    next = { title: 'Write the paper', text: sections.length ? filled + ' of ' + sections.length + ' sections written. Draft each section from your accepted evidence, then edit it in your own words.' : 'There’s a section for each part, plus an introduction and conclusion.', label: sections.length && filled ? 'Continue writing' : 'Start writing', href: base + '/paper' + (empty ? '?s=' + empty.id : '') };
  } else next = { title: 'Finish the project', text: 'Check the paper, save it as the final report and share it on the showcase website.', label: 'Finish project', href: base + '/paper/check' };
  // Co-authors and guests see where the project is, but the leader takes the steps.
  if (!leader && !completed) {
    const h = role === 'guest' ? null : next.action ? base + '/agents' : next.href && !next.href.includes('/finish') && !next.href.includes('/settings') && !next.href.includes('/check') ? next.href : null;
    next = { ...next, action: null, href: h, label: h ? 'Open' : null, text: next.text + ' The project leader takes this step.' };
  }
  return {
    steps, next, mode: manual ? 'manual' : 'agent', current: cur, currentIdx,
    stepLabel: completed ? 'Finished' : cur ? 'Step ' + cur.n + ' · ' + cur.label : '',
    parts,
    counts: { parts: n, researched, accepted, working, waiting, unassigned, sections: sections.length, filled },
    pct: Math.round((steps.filter((s) => s.done).length / steps.length) * 100)
  };
}

async function load(ids) {
  const parts = await db('parts').whereIn('topic_id', ids).orderBy('position').orderBy('id')
    .select('id', 'topic_id', 'title', 'agent_status', 'agent_progress', 'agent_step', 'agent_name', 'handler', 'proposed_user_id', 'due_date');
  const sections = await db('paper_sections').whereIn('topic_id', ids).select('id', 'topic_id', 'body', 'part_id');
  const tasks = await db('tasks').whereIn('topic_id', ids).whereNotNull('part_id').select('id', 'topic_id', 'part_id', 'status', 'assignee_id', 'due_date');
  return { parts, sections, tasks };
}

async function journeyOf(topic, role) {
  const { parts, sections, tasks } = await load([topic.id]);
  return compute(topic, role, parts, sections, tasks);
}

// Journeys for many topics with three queries. roleOf: topic id → role.
async function journeyMany(topics, roleOf) {
  if (!topics.length) return {};
  const { parts, sections, tasks } = await load(topics.map((t) => t.id));
  const out = {};
  for (const t of topics) out[t.id] = compute(t, (roleOf && roleOf[t.id]) || 'member', parts.filter((p) => p.topic_id === t.id), sections.filter((s) => s.topic_id === t.id), tasks.filter((x) => x.topic_id === t.id));
  return out;
}

module.exports = { journeyOf, journeyMany, partState, STEPS, MANUAL_STEPS };
