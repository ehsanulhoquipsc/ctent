'use strict';
// The AI label ("Gemini + backup Groq + backup …") can be longer than 80 characters, which stopped
// finished runs from saving on PostgreSQL. Widen the column, and give back the evidence of runs that
// failed only because of it: their cards were already saved, so they are ready for review.
exports.up = async function up(knex) {
  if (knex.client.config.client === 'pg') await knex.schema.alterTable('agent_runs', (t) => { t.text('model').alter(); });
  const runs = await knex('agent_runs').where('status', 'failed').where('error', 'like', '%value too long for type character varying(80)%').select('id', 'part_id');
  for (const r of runs) {
    const n = Number((await knex('agent_sources').where({ run_id: r.id }).count({ n: '*' }).first()).n);
    if (!n) continue;
    await knex('agent_runs').where({ id: r.id }).update({ status: 'done', error: null, summary: n + ' evidence cards. Tick the cards you want to use in the paper.', finished_at: new Date().toISOString() });
    const latest = await knex('agent_runs').where({ part_id: r.part_id }).orderBy('id', 'desc').first('id');
    if (latest && latest.id === r.id) await knex('parts').where({ id: r.part_id, agent_status: 'failed' }).update({ agent_status: 'review', agent_progress: 100, agent_step: 'Evidence cards ready for review' });
  }
};
exports.down = async function down(knex) {
  if (knex.client.config.client === 'pg') await knex.schema.alterTable('agent_runs', (t) => { t.string('model', 80).alter(); });
};
