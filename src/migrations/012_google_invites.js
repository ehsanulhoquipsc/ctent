'use strict';
// Sign in with Google, and invite links to share a project (or the whole workspace) with people.
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('google_sub', 64).unique(); // Google's stable account id, set on first Google sign-in
  });
  await knex.schema.createTable('invites', (t) => {
    t.increments('id');
    t.string('token', 64).notNullable().unique();
    t.integer('topic_id').references('topics.id').onDelete('CASCADE'); // null = join the workspace only
    t.string('role', 20).notNullable().defaultTo('member'); // project role (leader | member | guest), or platform role for workspace invites
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.integer('uses').notNullable().defaultTo(0);
    t.integer('max_uses'); // null = unlimited
    t.timestamp('expires_at');
    t.timestamp('revoked_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['topic_id']);
  });
};
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('invites');
  await knex.schema.alterTable('users', (t) => { t.dropColumn('google_sub'); });
};
