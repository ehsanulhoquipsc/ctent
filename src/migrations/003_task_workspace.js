'use strict';
// Task workspace: a leader's brief (goal, deliverable, "done when" points, starter files),
// the member's own steps, draft versions, progress updates and a task-only chat.

exports.up = async function up(knex) {
  await knex.schema.alterTable('tasks', (t) => {
    t.text('goal');
    t.string('deliverable', 30);
    t.integer('reviewer_id').references('users.id').onDelete('SET NULL');
    t.integer('round').notNullable().defaultTo(1);
    t.boolean('blocked').notNullable().defaultTo(false);
    t.timestamp('started_at');
    t.timestamp('submitted_at');
  });
  await knex.schema.createTable('task_criteria', (t) => {
    t.increments('id');
    t.integer('task_id').notNullable().references('tasks.id').onDelete('CASCADE');
    t.string('text', 300).notNullable();
    t.boolean('met').notNullable().defaultTo(false);
    t.integer('position').notNullable().defaultTo(0);
    t.index(['task_id']);
  });
  await knex.schema.createTable('task_steps', (t) => {
    t.increments('id');
    t.integer('task_id').notNullable().references('tasks.id').onDelete('CASCADE');
    t.string('text', 300).notNullable();
    t.boolean('done').notNullable().defaultTo(false);
    t.integer('position').notNullable().defaultTo(0);
    t.index(['task_id']);
  });
  await knex.schema.createTable('task_resources', (t) => {
    t.increments('id');
    t.integer('task_id').notNullable().references('tasks.id').onDelete('CASCADE');
    t.integer('file_id').references('files.id').onDelete('CASCADE');
    t.string('url', 500);
    t.string('title', 240);
  });
  await knex.schema.createTable('task_versions', (t) => {
    t.increments('id');
    t.integer('task_id').notNullable().references('tasks.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.integer('file_id').references('files.id').onDelete('SET NULL');
    t.string('state', 30).notNullable().defaultTo('draft'); // draft | in_review | changes | approved | superseded
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['task_id']);
  });
  await knex.schema.createTable('task_updates', (t) => {
    t.increments('id');
    t.integer('task_id').notNullable().references('tasks.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('SET NULL');
    t.string('kind', 30).notNullable(); // assigned | started | update | blocked | submitted | withdrawn | changes | approved | nudge
    t.text('text');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['task_id']);
  });
  await knex.schema.createTable('task_comments', (t) => {
    t.increments('id');
    t.integer('task_id').notNullable().references('tasks.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('SET NULL');
    t.text('body').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['task_id']);
  });
};

exports.down = async function down(knex) {
  for (const t of ['task_comments', 'task_updates', 'task_versions', 'task_resources', 'task_steps', 'task_criteria']) await knex.schema.dropTableIfExists(t);
  await knex.schema.alterTable('tasks', (t) => {
    for (const c of ['goal', 'deliverable', 'reviewer_id', 'round', 'blocked', 'started_at', 'submitted_at']) t.dropColumn(c);
  });
};
