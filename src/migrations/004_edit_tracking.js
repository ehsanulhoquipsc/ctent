'use strict';
// Track edits and soft-deletes so chats can show "edited" and live clients can update.
exports.up = async function up(knex) {
  await knex.schema.alterTable('messages', (t) => { t.timestamp('edited_at'); t.boolean('deleted').notNullable().defaultTo(false); });
  await knex.schema.alterTable('task_comments', (t) => { t.timestamp('edited_at'); });
  await knex.schema.alterTable('task_updates', (t) => { t.timestamp('edited_at'); });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('messages', (t) => { t.dropColumn('edited_at'); t.dropColumn('deleted'); });
  await knex.schema.alterTable('task_comments', (t) => { t.dropColumn('edited_at'); });
  await knex.schema.alterTable('task_updates', (t) => { t.dropColumn('edited_at'); });
};
