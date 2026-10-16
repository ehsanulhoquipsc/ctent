'use strict';
// The AI label ("Gemini + backup Groq + …") can be longer than 80 characters. Widen the column on PostgreSQL.
// Never block start-up: the code also shortens the label to fit, and agent.recover() restores affected runs.
exports.up = async function up(knex) {
  if (knex.client.config.client !== 'pg') return;
  try { await knex.raw('ALTER TABLE agent_runs ALTER COLUMN model TYPE text'); } catch (e) { console.error('Could not widen agent_runs.model:', e.message); }
};
exports.down = async function down() {};
