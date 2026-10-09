'use strict';

exports.up = async function up(knex) {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 200).notNullable();
    t.string('platform_role', 20).notNullable().defaultTo('member'); // admin | leader | member | guest
    t.string('institution', 160);
    t.string('title', 160);
    t.string('color', 20).defaultTo('indigo');
    t.string('status', 20).notNullable().defaultTo('active'); // active | suspended
    t.integer('weekly_hours').defaultTo(10);
    t.timestamp('last_login_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('expertise', (t) => {
    t.increments('id');
    t.integer('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('kind', 20).notNullable().defaultTo('field'); // field | method | region | language
    t.string('name', 120).notNullable();
    t.integer('level').notNullable().defaultTo(3);
    t.index(['user_id']);
  });

  await knex.schema.createTable('topics', (t) => {
    t.increments('id');
    t.string('code', 20).notNullable().unique();
    t.string('title', 240).notNullable();
    t.text('description');
    t.string('field', 120);
    t.string('status', 20).notNullable().defaultTo('active'); // planning | active | review | archived
    t.string('visibility', 20).notNullable().defaultTo('private');
    t.string('color', 20).defaultTo('burgundy');
    t.date('due_date');
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('topic_members', (t) => {
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('role', 20).notNullable().defaultTo('member'); // leader | member | guest
    t.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['topic_id', 'user_id']);
  });

  await knex.schema.createTable('join_requests', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.text('message');
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | accepted | declined
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('parts', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.string('title', 240).notNullable();
    t.text('description');
    t.string('skills', 400); // comma separated skills needed
    t.integer('proposed_user_id').references('users.id').onDelete('SET NULL');
    t.string('status', 20).notNullable().defaultTo('open'); // open | approved
    t.integer('approved_by').references('users.id').onDelete('SET NULL');
    t.date('due_date');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('tasks', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.integer('part_id').references('parts.id').onDelete('SET NULL');
    t.string('title', 240).notNullable();
    t.text('description');
    t.string('status', 20).notNullable().defaultTo('todo'); // todo | doing | review | done
    t.string('priority', 20).notNullable().defaultTo('normal'); // low | normal | high
    t.integer('assignee_id').references('users.id').onDelete('SET NULL');
    t.date('due_date');
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('completed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['topic_id', 'status']);
  });

  await knex.schema.createTable('channels', (t) => {
    t.increments('id');
    t.integer('topic_id').references('topics.id').onDelete('CASCADE');
    t.string('name', 80).notNullable();
    t.string('kind', 20).notNullable().defaultTo('topic'); // topic | room
    t.string('purpose', 240);
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('channel_members', (t) => {
    t.integer('channel_id').notNullable().references('channels.id').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.primary(['channel_id', 'user_id']);
  });

  await knex.schema.createTable('messages', (t) => {
    t.increments('id');
    t.integer('channel_id').notNullable().references('channels.id').onDelete('CASCADE');
    t.integer('user_id').references('users.id').onDelete('SET NULL');
    t.text('body').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['channel_id', 'id']);
  });

  await knex.schema.createTable('meetings', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.timestamp('starts_at').notNullable();
    t.integer('duration_min').notNullable().defaultTo(60);
    t.string('link', 500);
    t.string('platform', 40);
    t.text('agenda');
    t.text('minutes');
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('files', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.string('name', 255).notNullable();
    t.string('folder', 120).notNullable().defaultTo('General');
    t.string('mime', 120);
    t.integer('size').notNullable().defaultTo(0);
    t.binary('data');
    t.integer('uploaded_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('submissions', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.string('title', 240).notNullable();
    t.string('milestone', 120);
    t.string('status', 30).notNullable().defaultTo('in_review'); // in_review | changes | approved
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.integer('reviewer_id').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('submission_versions', (t) => {
    t.increments('id');
    t.integer('submission_id').notNullable().references('submissions.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.integer('file_id').references('files.id').onDelete('SET NULL');
    t.text('note');
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('reviews', (t) => {
    t.increments('id');
    t.integer('submission_id').notNullable().references('submissions.id').onDelete('CASCADE');
    t.integer('reviewer_id').references('users.id').onDelete('SET NULL');
    t.string('decision', 30).notNullable(); // approved | changes | comment
    t.text('comment');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('notifications', (t) => {
    t.increments('id');
    t.integer('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('kind', 30).notNullable();
    t.string('title', 240).notNullable();
    t.text('body');
    t.string('link', 300);
    t.timestamp('read_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'read_at']);
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.integer('user_id').references('users.id').onDelete('SET NULL');
    t.integer('topic_id').references('topics.id').onDelete('CASCADE');
    t.string('action', 60).notNullable();
    t.text('detail');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['topic_id']);
  });

  await knex.schema.createTable('sessions', (t) => {
    t.string('sid', 255).primary();
    t.text('sess').notNullable();
    t.bigInteger('expires').notNullable();
  });
};

exports.down = async function down(knex) {
  for (const t of ['sessions', 'audit_log', 'notifications', 'reviews', 'submission_versions', 'submissions', 'files', 'meetings', 'messages', 'channel_members', 'channels', 'tasks', 'parts', 'join_requests', 'topic_members', 'topics', 'expertise', 'users']) {
    await knex.schema.dropTableIfExists(t);
  }
};
