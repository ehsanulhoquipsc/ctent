'use strict';
// The project journey: five steps from a question to a finished paper, and the one next step to take.
//   1 Question  – research question written and split into parts
//   2 Research  – every part's agent has run
//   3 Review    – every part's evidence cards are accepted
//   4 Write     – the paper's sections are written
//   5 Finish    – final report chosen (topic completed)
const db = require('../db');

const STEPS = [
  { key: 'question', label: 'Question', hint: 'Ask it and split it into parts' },
  { key: 'research', label: 'Research', hint: 'Agents find the evidence' },
  { key: 'review', label: 'Review', hint: 'Pick the evidence to use' },
  { key: 'write', label: 'Write', hint: 'Draft the paper' },
  { key: 'finish', label: 'Finish', hint: 'Final report & showcase' }
];

async function journeyOf(topic, role) {
  const base = '/topics/' + topic.id;
  const leader = role === 'leader';
  const parts = await db('parts').where({ topic_id: topic.id }).orderBy('position').orderBy('id').select('id', 'title', 'agent_status', 'agent_progress');
  const sections = await db('paper_sections').where({ topic_id: topic.id }).select('id', 'body', 'part_id');
  const n = parts.length;
  const count = (keys) => parts.filter((p) => keys.includes(p.agent_status)).length;
  const researched = count(['review', 'accepted']);
  const accepted = count(['accepted']);
  const working = count(['queued', 'running']);
  const waiting = count(['draft', 'failed']);
  const toReview = parts.find((p) => p.agent_status === 'review');
  const filled = sections.filter((s) => String(s.body || '').trim()).length;
  const completed = topic.status === 'completed';
  const done = {
    question: !!topic.question && n > 0,
    research: n > 0 && researched === n,
    review: n > 0 && accepted === n,
    write: completed || (sections.length > 0 && filled === sections.length),
    finish: completed
  };
  const detail = {
    question: !topic.question ? 'No question yet' : n ? n + ' part' + (n === 1 ? '' : 's') : 'Not split into parts yet',
    research: !n ? 'Waiting for parts' : working ? working + ' agent' + (working === 1 ? '' : 's') + ' working' : researched + ' of ' + n + ' researched',
    review: !n ? 'Nothing to review yet' : accepted + ' of ' + n + ' accepted',
    write: sections.length ? filled + ' of ' + sections.length + ' sections written' : 'Not started',
    finish: completed ? 'Done' : 'Not finished'
  };
  const href = { question: base + '/agents#question', research: base + '/agents', review: toReview ? base + '/agents/' + toReview.id : base + '/agents', write: base + '/paper', finish: base + '/finish' };
  const currentIdx = completed ? 5 : STEPS.findIndex((s) => !done[s.key]);
  const steps = STEPS.map((s, i) => ({ ...s, n: i + 1, done: done[s.key], current: i === currentIdx, detail: detail[s.key], href: href[s.key] }));

  // The one thing to do next.
  let next;
  if (completed) next = { title: 'Project complete', text: 'The final report is saved with the project. Share it on the showcase website.', label: 'Open final report', href: base + '/finish' };
  else if (topic.status === 'archived') next = { title: 'This project is archived', text: 'It’s read-only. Reopen it from Settings to keep working.', label: 'Open settings', href: base + '/settings' };
  else if (!topic.question) next = { title: 'Write your research question', text: 'Every agent works from it. One or two sentences is enough.', label: 'Write the question', href: base + '/agents#question' };
  else if (!n) next = { title: 'Split the question into parts', text: 'Each part gets its own research agent. Let the AI suggest parts, or add your own.', label: 'Plan the parts', href: base + '/agents#parts' };
  else if (waiting && !working && researched < n) next = { title: 'Launch the agents', text: waiting + ' agent' + (waiting === 1 ? ' is' : 's are') + ' ready. They search papers, books and reports and come back with evidence cards.', label: 'Launch ' + (waiting === 1 ? 'the agent' : 'all ' + waiting + ' agents'), action: base + '/agents/launch-all' };
  else if (toReview) next = { title: 'Review the evidence for “' + toReview.title + '”', text: 'Tick the evidence cards you want in the paper, then accept them.', label: 'Review evidence', href: base + '/agents/' + toReview.id };
  else if (working) next = { title: 'The agents are researching', text: working + ' of ' + n + ' still working. You’ll get a notification as each one finishes — you can leave the page.', label: 'Watch progress', href: base + '/agents' };
  else if (waiting) next = { title: 'Launch the remaining agents', text: waiting + ' part' + (waiting === 1 ? ' still needs' : 's still need') + ' research.', label: 'Launch ' + (waiting === 1 ? 'the agent' : 'all ' + waiting + ' agents'), action: base + '/agents/launch-all' };
  else if (!done.write) {
    const empty = sections.find((s) => !String(s.body || '').trim());
    next = { title: 'Write the paper', text: sections.length ? filled + ' of ' + sections.length + ' sections written. Draft each section from your accepted evidence, then edit it in your own words.' : 'There’s a section for each part, plus an introduction and conclusion.', label: sections.length && filled ? 'Continue writing' : 'Start writing', href: base + '/paper' + (empty ? '?s=' + empty.id : '') };
  } else next = { title: 'Finish the project', text: 'Save the paper as the final report and share it on the showcase website.', label: 'Finish project', href: base + '/finish' };
  // Co-authors and guests see where the project is, but the leader takes the steps.
  if (!leader && !completed) {
    const href = role === 'guest' ? null : next.action ? base + '/agents' : next.href && !next.href.includes('/finish') && !next.href.includes('/settings') ? next.href : null;
    next = { ...next, action: null, href, label: href ? 'Open' : null, text: next.text + ' The project leader takes this step.' };
  }
  return { steps, next, counts: { parts: n, researched, accepted, working, waiting, sections: sections.length, filled }, pct: Math.round((steps.filter((s) => s.done).length / 5) * 100) };
}

module.exports = { journeyOf, STEPS };
