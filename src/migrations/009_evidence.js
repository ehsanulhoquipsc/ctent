'use strict';
// Evidence cards (from the CTENT Research Agent): every source an agent keeps becomes a card with findings, data,
// method, sample, limitations, a verified quote, quality flags and a Harvard citation. Runs also store their
// sub-question plan, the agreement map and the research gaps.
exports.up = async function up(knex) {
  await knex.schema.alterTable('parts', (t) => {
    t.string('agent_lang', 5).notNullable().defaultTo('en'); // en | bn
    t.string('agent_options', 120); // comma separated: fulltext,trail,synthesis,gaps
  });
  await knex.schema.alterTable('agent_runs', (t) => {
    t.string('depth', 20);
    t.string('lang', 5);
    t.text('plan'); // JSON: sub-questions and search queries
    t.text('synthesis'); // JSON: claims with supporting and contradicting cards
    t.text('gap_data'); // JSON: research gaps and the counts behind them
  });
  await knex.schema.alterTable('agent_sources', (t) => {
    t.text('question'); // the sub-question this card was found for
    t.string('source', 40); // main source key
    t.string('found_in', 400); // JSON list of source keys
    t.string('type', 20); // paper | book | report | reference | religious | web | news
    t.string('tier', 10); // high | medium | low reliability
    t.text('findings'); // JSON list
    t.text('data_points'); // JSON list
    t.text('method');
    t.text('sample');
    t.text('limitations');
    t.text('future');
    t.string('method_type', 60);
    t.string('country', 200);
    t.text('quote');
    t.string('flags', 100); // JSON list: retracted, preprint, check_journal
    t.boolean('fulltext').notNullable().defaultTo(false);
    t.string('via', 300); // citation trail: "Cited by (Smith, 2020)"
    t.text('pdf_url');
    t.string('publisher', 300);
    t.integer('relevance');
    t.float('score');
    t.boolean('selected').notNullable().defaultTo(false);
    t.string('in_text', 300);
    t.text('citation');
  });
  await knex.schema.alterTable('agent_findings', (t) => {
    t.integer('source_id').references('agent_sources.id').onDelete('CASCADE'); // the card this finding came from
  });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('agent_findings', (t) => { t.dropColumn('source_id'); });
  await knex.schema.alterTable('agent_sources', (t) => {
    for (const c of ['question', 'source', 'found_in', 'type', 'tier', 'findings', 'data_points', 'method', 'sample', 'limitations', 'future', 'method_type', 'country', 'quote', 'flags', 'fulltext', 'via', 'pdf_url', 'publisher', 'relevance', 'score', 'selected', 'in_text', 'citation']) t.dropColumn(c);
  });
  await knex.schema.alterTable('agent_runs', (t) => { for (const c of ['depth', 'lang', 'plan', 'synthesis', 'gap_data']) t.dropColumn(c); });
  await knex.schema.alterTable('parts', (t) => { t.dropColumn('agent_lang'); t.dropColumn('agent_options'); });
};
