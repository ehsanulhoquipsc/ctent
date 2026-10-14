"""Run research from the terminal:  python cli.py "your topic" --depth quick
Saves the run to the same database, so you can open it later in the web app."""
import argparse
import json

import agent
import config
import db
import exporter
import sources

p = argparse.ArgumentParser()
p.add_argument("topic")
p.add_argument("--depth", choices=list(config.DEPTHS), default="quick")
p.add_argument("--sources", help="comma-separated keys, default = all default sources")
a = p.parse_args()

db.init()
chosen = a.sources.split(",") if a.sources else [k for k, s in sources.SOURCES.items() if s["default"]]
run_id = db.create_run(a.topic, a.depth, chosen)
agent.run_research(run_id)
run = db.get_run(run_id)
print(run["log"])
items = db.get_items(run_id)
plan = json.loads(run["plan"] or "{}")
path = f"evidence_run{run_id}.md"
with open(path, "w", encoding="utf-8") as f:
    f.write(exporter.evidence_markdown(run, items, [q["question"] for q in plan.get("questions", [])]))
print(f"\n{len(items)} cards saved to {path}  (open run {run_id} in the web app to select cards)")
