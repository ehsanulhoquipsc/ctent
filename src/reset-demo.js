'use strict';
// Wipes the database and reloads the demo data: `npm run reset-demo`
require('./lib/env');
const db = require('./db');
const { seedDemo } = require('./seed');

(async () => {
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();
  await seedDemo();
  console.log('Demo data reset.');
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
