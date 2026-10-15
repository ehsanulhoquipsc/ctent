'use strict';
// Who handles a part: an AI agent, or a person (who gets a task with the part's brief and due date).
const db = require('../db');
const { notify } = require('./events');
const { now } = require('./util');

const validDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

// The task that carries a person's work on a part (latest one), if any.
async function taskOf(partId) { return db('tasks').where({ part_id: partId }).orderBy('id', 'desc').first(); }

// Give a part to a person: make sure they're in the project, create (or move) the task, notify them.
async function assignToPerson(topic, part, userId, due, by) {
  const person = await db('users').where({ id: userId, status: 'active' }).first();
  if (!person || person.platform_role === 'guest') return false;
  const m = await db('topic_members').where({ topic_id: topic.id, user_id: userId }).first();
  if (!m) await db('topic_members').insert({ topic_id: topic.id, user_id: userId, role: 'member', joined_at: now() });
  else if (m.role === 'guest') return false;
  const dueDate = validDate(due) || part.due_date || null;
  await db('parts').where({ id: part.id }).update({ handler: 'person', proposed_user_id: userId, due_date: dueDate, status: 'approved', approved_by: by.id });
  const open = await db('tasks').where({ part_id: part.id }).whereNot('status', 'done').orderBy('id', 'desc').first();
  let taskId;
  if (open) {
    taskId = open.id;
    await db('tasks').where({ id: open.id }).update({ assignee_id: userId, due_date: dueDate, updated_at: now() });
    await db('task_updates').insert({ task_id: open.id, user_id: by.id, kind: 'assigned', text: 'Given to ' + person.name + '.', created_at: now() });
  } else {
    taskId = await db.insertId('tasks', {
      topic_id: topic.id, part_id: part.id, title: part.title, goal: part.description || null, deliverable: 'doc', status: 'todo', priority: 'normal',
      assignee_id: userId, reviewer_id: by.id, due_date: dueDate, created_by: by.id, created_at: now(), updated_at: now()
    });
    await db('task_criteria').insert([
      { task_id: taskId, text: 'Answers the brief for this part', position: 0 },
      { task_id: taskId, text: 'Every claim has a source', position: 1 }
    ]);
    await db('task_updates').insert({ task_id: taskId, user_id: by.id, kind: 'assigned', text: 'Part given to ' + person.name + '.', created_at: now() });
  }
  if (userId !== by.id) await notify(userId, { kind: 'task', title: by.name + ' gave you a part: ' + part.title, body: topic.code + (dueDate ? ' · due ' + dueDate : '') + ' · open the brief to get started', link: '/topics/' + topic.id + '/tasks/' + taskId }, by.id);
  return taskId;
}

// Give a part to an AI agent. A person's unfinished task is closed, but their work stays on it.
async function assignToAgent(part, by) {
  const open = await db('tasks').where({ part_id: part.id }).whereNot('status', 'done').orderBy('id', 'desc').first();
  if (open) {
    await db('tasks').where({ id: open.id }).update({ status: 'done', completed_at: now(), updated_at: now() });
    await db('task_updates').insert({ task_id: open.id, user_id: by.id, kind: 'note', text: 'Handed to an AI agent. Work on this task is kept here.', created_at: now() });
    if (open.assignee_id && open.assignee_id !== by.id) await notify(open.assignee_id, { kind: 'task', title: 'An AI agent took over “' + part.title + '”', body: 'Your work on it is kept.', link: '/topics/' + part.topic_id + '/tasks/' + open.id }, by.id);
  }
  await db('parts').where({ id: part.id }).update({ handler: 'agent', agent_name: part.agent_name || part.title.split(/ [&,—-]/)[0].trim() + ' agent' });
}

module.exports = { assignToPerson, assignToAgent, taskOf, validDate };
