'use strict';
// New accounts wait for an admin (users.status = 'pending'); remember how each person joined.
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('joined_via', 240); // e.g. "Invite link from Ehsan Hoque · CT-0150"
    t.integer('pending_topic_id').references('topics.id').onDelete('SET NULL'); // project to join once approved
    t.string('pending_topic_role', 20);
    t.integer('approved_by').references('users.id').onDelete('SET NULL');
    t.timestamp('approved_at');
  });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => { for (const c of ['joined_via', 'pending_topic_id', 'pending_topic_role', 'approved_by', 'approved_at']) t.dropColumn(c); });
};
