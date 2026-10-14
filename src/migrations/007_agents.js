'use strict';
// AI agent workflow: each part of a topic gets an agent that finds sources and hands back findings.
// The researcher reviews them and writes the final paper from what they accept.
exports.up = async function up(knex) {
  await knex.schema.alterTable('topics', (t) => {
    t.text('question'); // the research question agents work from
    t.string('agent_since', 10); // only use sources published since this year
  });
  await knex.schema.alterTable('parts', (t) => {
    t.string('agent_name', 120);
    t.string('agent_sources', 200); // comma separated: papers,wiki
    t.string('agent_depth', 20); // quick | standard | deep
    t.string('agent_status', 20).notNullable().defaultTo('draft'); // draft | queued | running | review | accepted | failed
    t.integer('agent_progress').notNullable().defaultTo(0);
    t.string('agent_step', 240);
    t.integer('position').notNullable().defaultTo(0);
  });
  await knex.schema.createTable('agent_runs', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.integer('part_id').notNullable().references('parts.id').onDelete('CASCADE');
    t.string('status', 20).notNullable().defaultTo('running'); // running | done | failed
    t.text('followup'); // set when the researcher asked the agent to dig deeper
    t.text('summary');
    t.string('confidence', 10);
    t.text('gaps'); // one per line
    t.string('model', 80);
    t.text('error');
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('started_at');
    t.timestamp('finished_at');
    t.index(['part_id']);
  });
  await knex.schema.createTable('agent_sources', (t) => {
    t.increments('id');
    t.integer('run_id').notNullable().references('agent_runs.id').onDelete('CASCADE');
    t.integer('n').notNullable(); // number used in this run's citations
    t.string('kind', 20); // paper | wiki
    t.text('title');
    t.text('authors');
    t.integer('year');
    t.string('venue', 300);
    t.text('url');
    t.string('doi', 200);
    t.integer('cited_by');
    t.text('abstract');
    t.index(['run_id']);
  });
  await knex.schema.createTable('agent_findings', (t) => {
    t.increments('id');
    t.integer('run_id').notNullable().references('agent_runs.id').onDelete('CASCADE');
    t.integer('part_id').notNullable().references('parts.id').onDelete('CASCADE');
    t.integer('position').notNullable().defaultTo(0);
    t.text('text').notNullable();
    t.string('confidence', 10);
    t.string('cites', 200); // source numbers in this run, comma separated
    t.boolean('kept').notNullable().defaultTo(true);
    t.index(['run_id']);
  });
  await knex.schema.createTable('agent_logs', (t) => {
    t.increments('id');
    t.integer('run_id').notNullable().references('agent_runs.id').onDelete('CASCADE');
    t.text('text').notNullable();
    t.timestamp('created_at');
    t.index(['run_id']);
  });
  await knex.schema.createTable('agent_comments', (t) => {
    t.increments('id');
    t.integer('part_id').notNullable().references('parts.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('SET NULL');
    t.text('body').notNullable();
    t.timestamp('created_at');
  });
  await knex.schema.createTable('paper_sections', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.integer('part_id').references('parts.id').onDelete('SET NULL');
    t.integer('position').notNullable().defaultTo(0);
    t.string('title', 240).notNullable();
    t.text('body');
    t.integer('updated_by').references('users.id').onDelete('SET NULL');
    t.timestamp('updated_at');
  });
  await knex.schema.createTable('paper_comments', (t) => {
    t.increments('id');
    t.integer('section_id').notNullable().references('paper_sections.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('SET NULL');
    t.text('body').notNullable();
    t.boolean('resolved').notNullable().defaultTo(false);
    t.timestamp('created_at');
  });
};
exports.down = async function down(knex) {
  for (const t of ['paper_comments', 'paper_sections', 'agent_comments', 'agent_logs', 'agent_findings', 'agent_sources', 'agent_runs']) await knex.schema.dropTableIfExists(t);
  await knex.schema.alterTable('parts', (t) => { for (const c of ['agent_name', 'agent_sources', 'agent_depth', 'agent_status', 'agent_progress', 'agent_step', 'position']) t.dropColumn(c); });
  await knex.schema.alterTable('topics', (t) => { t.dropColumn('question'); t.dropColumn('agent_since'); });
};
