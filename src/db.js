'use strict';
const path = require('path');
const knexLib = require('knex');

// Postgres: keep DATE columns as 'YYYY-MM-DD' strings and COUNT(*) as numbers,
// so both databases hand the app the same shapes.
try {
  const { types } = require('pg');
  types.setTypeParser(1082, (v) => v);
  types.setTypeParser(20, (v) => parseInt(v, 10));
  types.setTypeParser(1700, (v) => parseFloat(v));
} catch (e) { /* pg not installed */ }

// One database layer for both environments:
// - DATABASE_URL set (Render, production) -> PostgreSQL
// - otherwise -> a local SQLite file (zero setup for development)
function makeConfig() {
  const migrations = { directory: path.join(__dirname, 'migrations') };
  if (process.env.DATABASE_URL) {
    // Render's internal URL (host without dots) needs no SSL; external URLs do.
    const useSsl = process.env.PGSSL === 'true' || (process.env.PGSSL !== 'false' && /\.render\.com|sslmode=require/.test(process.env.DATABASE_URL));
    return {
      client: 'pg',
      connection: { connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : false },
      pool: { min: 0, max: 8 },
      migrations
    };
  }
  const file = process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'ctent.sqlite');
  if (file !== ':memory:') require('fs').mkdirSync(path.dirname(file), { recursive: true });
  return {
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: { afterCreate: (conn, done) => { conn.pragma('foreign_keys = ON'); done(); } },
    migrations
  };
}

const db = knexLib(makeConfig());
db.isPg = db.client.config.client === 'pg';

// Insert a row and return its new id on both SQLite and Postgres.
db.insertId = async function insertId(table, row, trx) {
  const q = (trx || db)(table).insert(row).returning('id');
  const res = await q;
  const first = res[0];
  return typeof first === 'object' ? first.id : first;
};

module.exports = db;
