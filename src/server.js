'use strict';
require('./lib/env');
const db = require('./db');
const { createApp } = require('./app');
const { ensureSeeded } = require('./seed');

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.warn('WARNING: SESSION_SECRET is not set. Set it in your host’s environment settings.');
  }
  await db.migrate.latest();
  if (await ensureSeeded()) console.log('Demo data loaded. Sign in with any @ctent.demo account (password: demo1234).');
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log('CTENT running on http://localhost:' + port + (db.isPg ? ' (PostgreSQL)' : ' (SQLite)')));
}

main().catch((e) => { console.error(e); process.exit(1); });
