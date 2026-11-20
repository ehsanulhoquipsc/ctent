'use strict';
// Step 6 · Publish: a library of writing styles (admin), and runs that turn the final paper into a Bangla
// Facebook post and English + Bangla website articles, with every claim checked against the paper.
exports.up = async (knex) => {
  await knex.schema.createTable('styles', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('rights', 20).notNullable(); // permission | classic
    t.integer('died_year');
    t.string('proof_name', 200);
    t.string('proof_type', 100);
    t.binary('proof_data');
    t.text('samples').notNullable(); // JSON list of passages
    t.text('card'); // the style card, editable
    t.text('metrics'); // JSON measured from the samples
    t.text('examples'); // JSON: short passages shown to the writer agent
    t.integer('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.string('created_at', 40);
    t.string('updated_at', 40);
  });
  await knex.schema.createTable('publish_runs', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('id').inTable('topics').onDelete('CASCADE');
    t.integer('style_id').references('id').inTable('styles').onDelete('SET NULL');
    t.string('style_name', 120);
    t.text('settings');
    t.string('status', 20).notNullable().defaultTo('queued'); // queued | running | done | failed
    t.string('step', 200);
    t.integer('progress').notNullable().defaultTo(0);
    t.text('error');
    t.text('facts'); // JSON fact sheet
    t.string('model', 200);
    t.integer('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.string('created_at', 40);
    t.string('finished_at', 40);
    t.index(['topic_id']);
  });
  await knex.schema.createTable('publish_outputs', (t) => {
    t.increments('id');
    t.integer('run_id').notNullable().references('id').inTable('publish_runs').onDelete('CASCADE');
    t.string('format', 10).notNullable(); // fb | web_en | web_bn
    t.string('title', 300);
    t.string('subtitle', 500);
    t.text('body');
    t.boolean('edited').notNullable().defaultTo(false);
    t.integer('updated_by').references('id').inTable('users').onDelete('SET NULL');
    t.string('updated_at', 40);
    t.index(['run_id']);
  });
  await knex.schema.createTable('publish_claims', (t) => {
    t.increments('id');
    t.integer('output_id').notNullable().references('id').inTable('publish_outputs').onDelete('CASCADE');
    t.text('quote').notNullable();
    t.string('status', 20).notNullable(); // ok | changed | unsupported | copied
    t.text('fact');
    t.string('source', 300);
    t.boolean('resolved').notNullable().defaultTo(false);
    t.index(['output_id']);
  });
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('publish_claims');
  await knex.schema.dropTableIfExists('publish_outputs');
  await knex.schema.dropTableIfExists('publish_runs');
  await knex.schema.dropTableIfExists('styles');
};
