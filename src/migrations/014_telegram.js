'use strict';
// Sign in with Telegram, and a note of which sign-in methods each account really has.
exports.up = async (knex) => {
  await knex.schema.alterTable('users', (t) => {
    t.string('telegram_id', 32).unique();
    t.string('telegram_username', 64);
    t.boolean('has_password').notNullable().defaultTo(true);
    t.boolean('email_verified').notNullable().defaultTo(true);
  });
  // Accounts made with Google got a random password nobody knows.
  await knex('users').whereNotNull('google_sub').update({ has_password: false });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('users', (t) => { t.dropColumn('telegram_id'); t.dropColumn('telegram_username'); t.dropColumn('has_password'); t.dropColumn('email_verified'); });
};
