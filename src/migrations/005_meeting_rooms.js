'use strict';
// Standing meeting rooms: one project room per topic (everyone in the topic) plus extra team rooms.
exports.up = async function up(knex) {
  await knex.schema.createTable('meeting_rooms', (t) => {
    t.increments('id');
    t.integer('topic_id').notNullable().references('topics.id').onDelete('CASCADE');
    t.string('name', 80).notNullable();
    t.string('kind', 16).notNullable().defaultTo('team'); // project | team
    t.string('purpose', 240);
    t.text('link');
    t.string('platform', 40);
    t.integer('part_id').references('parts.id').onDelete('SET NULL');
    t.integer('task_id').references('tasks.id').onDelete('SET NULL');
    t.integer('channel_id').references('channels.id').onDelete('SET NULL');
    t.integer('created_by').references('users.id').onDelete('SET NULL');
    t.timestamp('created_at');
    t.index(['topic_id']);
  });
  await knex.schema.createTable('meeting_room_members', (t) => {
    t.integer('room_id').notNullable().references('meeting_rooms.id').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.primary(['room_id', 'user_id']);
  });
  await knex.schema.alterTable('meetings', (t) => {
    t.integer('room_id').references('meeting_rooms.id').onDelete('SET NULL');
  });
};
exports.down = async function down(knex) {
  await knex.schema.alterTable('meetings', (t) => { t.dropColumn('room_id'); });
  await knex.schema.dropTableIfExists('meeting_room_members');
  await knex.schema.dropTableIfExists('meeting_rooms');
};
