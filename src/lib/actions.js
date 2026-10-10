'use strict';
const db = require('../db');
const { todayStr } = require('./util');

// Everything waiting on this user's decision, across their topics.
async function actionItems(user) {
  let led;
  if (user.platform_role === 'admin') led = (await db('topics').whereNot('status', 'archived').select('id')).map((r) => r.id);
  else led = (await db('topic_members').where({ user_id: user.id, role: 'leader' }).select('topic_id')).map((r) => r.topic_id);
  const items = [];
  if (led.length) {
    const parts = await db('parts').join('topics', 'topics.id', 'parts.topic_id').leftJoin('users', 'users.id', 'parts.proposed_user_id')
      .whereIn('parts.topic_id', led).where('parts.status', 'open')
      .select('parts.id', 'parts.title', 'parts.topic_id', 'parts.created_at', 'topics.code', 'users.name as proposed');
    for (const p of parts) {
      items.push(p.proposed
        ? { type: 'Approval', title: 'Approve owner for “' + p.title + '”', detail: p.proposed + ' is proposed for this part.', topic: p.code, href: '/topics/' + p.topic_id + '/plan', urgent: false, at: p.created_at }
        : { type: 'Approval', title: 'Choose an owner for “' + p.title + '”', detail: 'Nobody is assigned to this part yet.', topic: p.code, href: '/topics/' + p.topic_id + '/plan', urgent: true, at: p.created_at });
    }
    const subs = await db('submissions').join('topics', 'topics.id', 'submissions.topic_id').leftJoin('users', 'users.id', 'submissions.created_by')
      .whereIn('submissions.topic_id', led).where('submissions.status', 'in_review').whereNot('submissions.created_by', user.id)
      .select('submissions.id', 'submissions.title', 'submissions.topic_id', 'submissions.updated_at', 'topics.code', 'users.name as author');
    for (const s of subs) items.push({ type: 'Review', title: 'Review “' + s.title + '”', detail: 'Submitted by ' + (s.author || 'a member') + '.', topic: s.code, href: '/topics/' + s.topic_id + '/submissions/' + s.id, urgent: false, at: s.updated_at });
    const reqs = await db('join_requests').join('topics', 'topics.id', 'join_requests.topic_id').join('users', 'users.id', 'join_requests.user_id')
      .whereIn('join_requests.topic_id', led).where('join_requests.status', 'pending')
      .select('join_requests.id', 'join_requests.message', 'join_requests.topic_id', 'join_requests.created_at', 'topics.code', 'users.name', 'users.id as uid');
    for (const r of reqs) items.push({ type: 'Request', title: r.name + ' asked to join', detail: r.message || 'No message.', topic: r.code, href: '/actions#req-' + r.id, urgent: false, at: r.created_at, requestId: r.id, personHref: '/people/' + r.uid });
  }
  // Tasks with a brief waiting for this user's review, and blocked tasks they lead
  const taskReviews = await db('tasks').join('topics', 'topics.id', 'tasks.topic_id').leftJoin('users', 'users.id', 'tasks.assignee_id')
    .where('tasks.status', 'review').where((w) => { w.where('tasks.reviewer_id', user.id); if (led.length) w.orWhere((x) => x.whereNull('tasks.reviewer_id').whereIn('tasks.topic_id', led)); })
    .whereNot('tasks.assignee_id', user.id).select('tasks.id', 'tasks.title', 'tasks.topic_id', 'tasks.submitted_at', 'topics.code', 'users.name as who');
  for (const t of taskReviews) items.push({ type: 'Review', title: 'Review task “' + t.title + '”', detail: (t.who || 'Someone') + ' submitted it for review.', topic: t.code, href: '/topics/' + t.topic_id + '/tasks/' + t.id + '#review', urgent: false, at: t.submitted_at });
  if (led.length) {
    const blocked = await db('tasks').join('topics', 'topics.id', 'tasks.topic_id').leftJoin('users', 'users.id', 'tasks.assignee_id')
      .whereIn('tasks.topic_id', led).where('tasks.blocked', true).whereIn('tasks.status', ['todo', 'doing', 'changes']).select('tasks.id', 'tasks.title', 'tasks.topic_id', 'topics.code', 'users.name as who');
    for (const t of blocked) items.push({ type: 'Blocked', title: (t.who || 'Someone') + ' is blocked on “' + t.title + '”', detail: 'They asked for help. Open the task to see the update.', topic: t.code, href: '/topics/' + t.topic_id + '/tasks/' + t.id + '?tab=updates', urgent: true, at: null });
  }
  const overdue = await db('tasks').join('topics', 'topics.id', 'tasks.topic_id').where('tasks.assignee_id', user.id).whereNot('tasks.status', 'done')
    .where('tasks.due_date', '<', todayStr(0)).select('tasks.id', 'tasks.title', 'tasks.topic_id', 'tasks.due_date', 'topics.code');
  for (const t of overdue) items.push({ type: 'Overdue', title: 'Overdue: ' + t.title, detail: 'Was due ' + t.due_date + '. Update it or move the date.', topic: t.code, href: '/topics/' + t.topic_id + '/board', urgent: true, at: t.due_date });
  items.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  return items;
}

module.exports = { actionItems };
