"""SQLite storage: one row per research run, one row per evidence card."""
import datetime
import json
import sqlite3

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, depth TEXT, sources TEXT,
    status TEXT, log TEXT DEFAULT '', plan TEXT, draft TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, question TEXT, source TEXT, found_in TEXT,
    type TEXT, tier TEXT, title TEXT, authors TEXT, year TEXT, venue TEXT, abstract TEXT, url TEXT,
    doi TEXT, citations INTEGER, score REAL, relevance INTEGER, findings TEXT, data_points TEXT,
    quote TEXT, citation TEXT, in_text TEXT, selected INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_items_run ON items(run_id);
"""
JSON_COLS = ("authors", "found_in", "findings", "data_points", "flags")
# Columns added after the first version; created automatically on older databases.
EXTRA_COLS = {
    "runs": {"lang": "TEXT DEFAULT 'en'", "options": "TEXT DEFAULT '{}'", "synthesis": "TEXT", "gaps": "TEXT"},
    "items": {"method": "TEXT", "sample": "TEXT", "limitations": "TEXT", "flags": "TEXT", "fulltext": "INTEGER DEFAULT 0",
              "via": "TEXT", "pdf_url": "TEXT", "publisher": "TEXT", "future": "TEXT", "method_type": "TEXT",
              "country": "TEXT"},
}


def conn():
    c = sqlite3.connect(config.DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        for table, cols in EXTRA_COLS.items():
            have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
            for col, typ in cols.items():
                if col not in have:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        c.execute("UPDATE runs SET status='interrupted' WHERE status NOT IN ('done','error','interrupted')")


def create_run(topic, depth, sources, lang="en", options=None):
    opts = {"fulltext": True, "trail": True, "synthesis": True, "gaps": True} if options is None else options
    with conn() as c:
        cur = c.execute("INSERT INTO runs(topic, depth, sources, lang, options, status, created) VALUES (?,?,?,?,?,?,?)",
                        (topic, depth, json.dumps(sources), lang, json.dumps(opts), "queued",
                         datetime.datetime.now().strftime("%Y-%m-%d %H:%M")))
        return cur.lastrowid


def update_run(run_id, **fields):
    with conn() as c:
        c.execute(f"UPDATE runs SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), run_id))


def append_log(run_id, msg):
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    with conn() as c:
        c.execute("UPDATE runs SET log = COALESCE(log,'') || ? WHERE id=?", (f"[{stamp}] {msg}\n", run_id))


def get_run(run_id):
    with conn() as c:
        r = c.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        return dict(r) if r else None


def list_runs(limit=30):
    with conn() as c:
        rows = c.execute("SELECT r.*, (SELECT COUNT(*) FROM items i WHERE i.run_id=r.id) AS n_items, "
                         "(SELECT COUNT(*) FROM items i WHERE i.run_id=r.id AND selected=1) AS n_selected "
                         "FROM runs r ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


def insert_items(run_id, items):
    cols = ["question", "source", "found_in", "type", "tier", "title", "authors", "year", "venue", "abstract",
            "url", "doi", "citations", "score", "relevance", "findings", "data_points", "quote", "citation", "in_text",
            "method", "sample", "limitations", "flags", "fulltext", "via", "pdf_url", "publisher",
            "future", "method_type", "country"]
    sql = f"INSERT INTO items(run_id, {', '.join(cols)}) VALUES ({', '.join('?' * (len(cols) + 1))})"
    with conn() as c:
        for it in items:  # one by one so each item learns its database id
            row = [run_id] + [json.dumps(it.get(k) or [], ensure_ascii=False) if k in JSON_COLS
                              else (int(bool(it.get(k))) if k == "fulltext" else it.get(k)) for k in cols]
            it["id"] = c.execute(sql, row).lastrowid


def _row(r):
    d = dict(r)
    for k in JSON_COLS:
        d[k] = json.loads(d[k] or "[]")
    return d


def get_items(run_id, selected_only=False):
    q = "SELECT * FROM items WHERE run_id=?" + (" AND selected=1" if selected_only else "") + " ORDER BY score DESC"
    with conn() as c:
        return [_row(r) for r in c.execute(q, (run_id,)).fetchall()]


def set_selected(item_ids, selected):
    with conn() as c:
        c.executemany("UPDATE items SET selected=? WHERE id=?", [(1 if selected else 0, i) for i in item_ids])
