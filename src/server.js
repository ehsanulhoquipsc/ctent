'use strict';
require('./lib/env');
const db = require('./db');
const { createApp } = require('./app');
const { ensureSeeded } = require('./seed');

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.warn('WARNING: SESSION_SECRET is not set. Set it in your host’s environment settings.');
  }
  // A deploy that was stopped mid-migration leaves the migration lock set, and every later start-up would
  // fail on it. Only one instance migrates at a time here, so a lock found at start-up is stale.
  try { await db.migrate.forceFreeMigrationsLock(); } catch (e) { /* no migration tables yet */ }
  await db.migrate.latest();
  // Moving databases: copy everything from the old one into this empty one (see README).
  try { await require('./lib/copy-db').copyIfAsked(); } catch (e) { console.error('Copying from the old database failed — nothing was changed here:', e.message); }
  if (await ensureSeeded()) console.log('Demo data loaded. Sign in with any @ctent.demo account (password: demo1234).');
  await require('./lib/agent').recover();
  console.log('AI agents: ' + require('./lib/llm').label());
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log('CTENT running on http://localhost:' + port + (db.isPg ? ' (PostgreSQL)' : ' (SQLite)')));
}

main().catch((e) => { console.error(e); process.exit(1); });
