'use strict';
// How many AI calls each service handled per day and per feature, for the AI allowance meter.
exports.up = async (knex) => {
  await knex.schema.createTable('ai_usage', (t) => {
    t.increments('id');
    t.string('day', 10).notNullable(); // the service's own day (Gemini: Pacific time, others: UTC); 'limit' = a learned daily cap
    t.string('provider', 20).notNullable();
    t.string('feature', 20).notNullable(); // agents | paper | publish | other
    t.integer('calls').notNullable().defaultTo(0);
    t.integer('fails').notNullable().defaultTo(0);
    t.unique(['day', 'provider', 'feature']);
  });
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('ai_usage'); };
