'use strict';
// One-time move of all data from another PostgreSQL database into this one (e.g. Render's free
// database, which expires, into Neon). Runs at start-up when COPY_FROM_DATABASE_URL is set and this
// database has no users yet. Tables are copied parents first, ids are kept, and id counters are reset.
const knexLib = require('knex');
const db = require('../db');

const SKIP = new Set(['knex_migrations', 'knex_migrations_lock', 'sessions']);

function sourceConfig(url) {
  const clean = url.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const ssl = /\.render\.com|sslmode=require|neon\.tech|supabase/.test(clean) ? { rejectUnauthorized: false } : false;
  return { client: 'pg', connection: { connectionString: clean, ssl }, pool: { min: 0, max: 2 } };
}

async function tablesOf(knex) {
  const rows = await knex.raw("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
  return rows.rows.map((r) => r.table_name).filter((t) => !SKIP.has(t));
}

async function fkeys() {
  const r = await db.raw(`select tc.table_name as child, kcu.column_name as col, ccu.table_name as parent, c.is_nullable = 'YES' as nullable
    from information_schema.table_constraints tc
    join information_schema.columns c on c.table_schema = tc.table_schema and c.table_name = tc.table_name
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public' and c.column_name = kcu.column_name`);
  return r;
}

// Parents before children, using this database's foreign keys. Cycles are broken; see copyFrom.
async function ordered(tables) {
  const fk = await fkeys();
  const deps = Object.fromEntries(tables.map((t) => [t, new Set()]));
  // Only required links decide the order; optional ones to a later table are filled in afterwards.
  for (const r of fk.rows) if (!r.nullable && deps[r.child] && deps[r.parent] && r.child !== r.parent) deps[r.child].add(r.parent);
  const out = [];
  const seen = new Set();
  const visit = (t, stack) => {
    if (seen.has(t)) return;
    if (stack.has(t)) return; // a cycle: break it
    stack.add(t);
    for (const p of deps[t]) visit(p, stack);
    stack.delete(t);
    seen.add(t);
    out.push(t);
  };
  tables.forEach((t) => visit(t, new Set()));
  return out;
}

async function columnsOf(knex, table) {
  const r = await knex.raw("select column_name from information_schema.columns where table_schema = 'public' and table_name = ?", [table]);
  return r.rows.map((x) => x.column_name);
}

async function copyFrom(url, log = console.log) {
  if (!db.isPg) throw new Error('Copying is only for PostgreSQL.');
  const src = knexLib(sourceConfig(url));
  try {
    const srcTables = new Set(await tablesOf(src));
    const tables = (await ordered(await tablesOf(db))).filter((t) => srcTables.has(t));
    const counts = {};
    const fks = (await fkeys()).rows;
    const later = []; // [table, column] links to a table copied later (a cycle): filled in at the end
    await db.transaction(async (trx) => {
      const done = new Set();
      for (const t of tables) {
        const defer = fks.filter((f) => f.child === t && f.nullable && f.parent !== t && !done.has(f.parent) && tables.includes(f.parent)).map((f) => f.col);
        const cols = await columnsOf(trx, t);
        const srcCols = new Set(await columnsOf(src, t));
        const both = cols.filter((c) => srcCols.has(c));
        const hasId = both.includes('id');
        let n = 0, last = 0;
        for (;;) {
          // Page by id where there is one (keeps memory low for files); otherwise read the whole table.
          const rows = hasId ? await src(t).select(both).where('id', '>', last).orderBy('id').limit(200) : await src(t).select(both);
          if (!rows.length) break;
          if (defer.length) for (const r of rows) for (const c of defer) if (r[c] != null) { later.push([t, c, r.id, r[c]]); r[c] = null; }
          await trx(t).insert(rows);
          n += rows.length;
          if (!hasId) break;
          last = rows[rows.length - 1].id;
        }
        counts[t] = n;
        done.add(t);
        if (hasId && n) await trx.raw("select setval(pg_get_serial_sequence(?, 'id'), (select max(id) from ??))", [t, t]);
      }
      for (const [t, c, id, v] of later) await trx(t).where({ id }).update({ [c]: v });
    });
    log('Copied data from the old database: ' + Object.entries(counts).filter(([, n]) => n).map(([t, n]) => t + ' ' + n).join(', '));
    return counts;
  } finally { await src.destroy(); }
}

// At start-up: copy once, only into an empty database.
async function copyIfAsked() {
  const url = process.env.COPY_FROM_DATABASE_URL;
  if (!url || !db.isPg) return false;
  if (url === process.env.DATABASE_URL) { console.warn('COPY_FROM_DATABASE_URL is the same as DATABASE_URL — nothing to copy.'); return false; }
  const users = Number((await db('users').count({ n: '*' }).first()).n);
  if (users > 0) { console.log('COPY_FROM_DATABASE_URL is set but this database already has data, so nothing was copied. You can remove COPY_FROM_DATABASE_URL.'); return false; }
  await copyFrom(url);
  return true;
}

module.exports = { copyFrom, copyIfAsked };
