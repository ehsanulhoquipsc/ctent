'use strict';
// Finishing a project: completion date and the chosen final report.
exports.up = async function up(knex) {
  await knex.schema.alterTable('topics', (t) => {
    t.integer('final_file_id').references('files.id').onDelete('SET NULL');
    t.string('final_title', 200);
    t.text('final_note');
    t.timestamp('completed_at');
    t.integer('completed_by').references('users.id').onDelete('SET NULL');
  });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('topics', (t) => {
    t.dropColumn('final_file_id'); t.dropColumn('final_title'); t.dropColumn('final_note'); t.dropColumn('completed_at'); t.dropColumn('completed_by');
  });
};
