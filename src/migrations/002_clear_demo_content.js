'use strict';
// One-time cleanup (requested 10 Oct 2026): start the live workspace fresh.
// Deletes all topics and their content; user accounts are kept.
const { wipeContent } = require('../lib/wipe');

exports.up = async function up(knex) { await wipeContent(knex); };
exports.down = async function down() { /* data can't be restored */ };
