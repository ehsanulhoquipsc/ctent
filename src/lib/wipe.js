'use strict';
// Removes all workspace content but keeps user accounts (logins, roles, expertise).
const CONTENT_TABLES = ['task_comments', 'task_updates', 'task_versions', 'task_resources', 'task_steps', 'task_criteria', 'reviews', 'submission_versions', 'submissions', 'files', 'meetings', 'messages', 'channel_members', 'channels', 'tasks', 'parts', 'join_requests', 'topic_members', 'topics', 'notifications', 'audit_log'];

async function wipeContent(knex) {
  await knex.transaction(async (trx) => {
    for (const t of CONTENT_TABLES) if (await trx.schema.hasTable(t)) await trx(t).del();
  });
}

module.exports = { wipeContent, CONTENT_TABLES };
