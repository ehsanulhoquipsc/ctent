'use strict';
// Agent mode vs manual mode, and who handles each part.
exports.up = async function up(knex) {
  await knex.schema.alterTable('topics', (t) => {
    t.string('mode', 10).notNullable().defaultTo('agent'); // agent | manual
  });
  await knex.schema.alterTable('parts', (t) => {
    t.string('handler', 10).notNullable().defaultTo('agent'); // agent | person (proposed_user_id is the person)
  });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('parts', (t) => { t.dropColumn('handler'); });
  await knex.schema.alterTable('topics', (t) => { t.dropColumn('mode'); });
};
