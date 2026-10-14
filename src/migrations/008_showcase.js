'use strict';
// Papers chosen for the public showcase website.
exports.up = async function up(knex) {
  await knex.schema.alterTable('topics', (t) => {
    t.boolean('showcase').notNullable().defaultTo(false);
    t.timestamp('showcase_at');
  });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('topics', (t) => { t.dropColumn('showcase'); t.dropColumn('showcase_at'); });
};
