"""CTENT Research Agent - local web app. Run:  python app.py  then open http://localhost:5000"""
import json
import os
import re
import threading

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, url_for

import agent
import config
import db
import exporter
import llm
import gaps as gapfinder
import matrix
import sources
from icons import icon
from translations import STRINGS, method_label

app = Flask(__name__)
db.init()


def ui_lang():
    lang = request.args.get("ui") or request.cookies.get("ui") or "en"
    return lang if lang in STRINGS else "en"


@app.context_processor
def inject_strings():
    lang = ui_lang()
    strings = STRINGS[lang]
    runs = db.list_runs(200)
    return {"t": lambda key: strings.get(key, STRINGS["en"].get(key, key)), "ui": lang, "T": strings,
            "icon": icon, "recent_runs": runs[:6], "total_runs": len(runs), "ai_on": llm.enabled(),
            "ai_label": llm.label(), "ctent_url": config.CTENT_URL}


@app.after_request
def remember_ui(resp):
    if request.args.get("ui") in STRINGS:
        resp.set_cookie("ui", request.args["ui"], max_age=60 * 60 * 24 * 365)
    return resp


def _source_groups():
    groups = {}
    for key, s in sources.SOURCES.items():
        groups.setdefault(s["group"], []).append({
            "key": key, "label": s["label"], "default": s["default"],
            "available": sources.is_available(key), "needs": s.get("needs", ""),
            "bd": s["group"] == "Bangladesh sources"})
    return groups


@app.get("/")
def index():
    return render_template("index.html", groups=_source_groups(), depths=config.DEPTHS, runs=db.list_runs(5),
                           openalex_key=bool(config.OPENALEX_API_KEY), active="new")


@app.get("/history")
def history():
    return render_template("history.html", runs=db.list_runs(500), active="history")


@app.post("/run")
def new_run():
    topic = (request.form.get("topic") or "").strip()
    depth = request.form.get("depth") if request.form.get("depth") in config.DEPTHS else "standard"
    lang = request.form.get("lang") if request.form.get("lang") in ("en", "bn") else "en"
    chosen = [s for s in request.form.getlist("sources") if s in sources.SOURCES]
    if not topic or not chosen:
        return redirect(url_for("index"))
    options = {k: request.form.get(f"opt_{k}") == "on" for k in ("fulltext", "trail", "synthesis", "gaps")}
    run_id = db.create_run(topic, depth, chosen, lang, options)
    threading.Thread(target=agent.run_research, args=(run_id,), daemon=True).start()
    return redirect(url_for("run_page", run_id=run_id))


@app.get("/run/<int:run_id>")
def run_page(run_id):
    run = db.get_run(run_id) or abort(404)
    labels = {k: s["label"] for k, s in sources.SOURCES.items()}
    labels["citation_trail"] = sources.label("citation_trail")
    lang = run.get("lang") or "en"
    methods = {m: method_label(lang, m) for m in gapfinder.METHOD_TYPES}
    return render_template("run.html", run=run, labels=labels, methods=methods, current_run=run_id)


@app.get("/api/run/<int:run_id>")
def run_status(run_id):
    run = db.get_run(run_id) or abort(404)
    return jsonify(status=run["status"], log=run["log"] or "", has_draft=bool(run["draft"]))


@app.get("/api/run/<int:run_id>/synthesis")
def run_synthesis(run_id):
    run = db.get_run(run_id) or abort(404)
    return jsonify(json.loads(run.get("synthesis") or "[]"))


@app.get("/api/run/<int:run_id>/gaps")
def run_gaps(run_id):
    run = db.get_run(run_id) or abort(404)
    return jsonify(json.loads(run.get("gaps") or "{}"))


@app.post("/api/run/<int:run_id>/gaps")
def rerun_gaps(run_id):
    db.get_run(run_id) or abort(404)
    scope = (request.get_json(silent=True) or {}).get("scope", "all")
    try:
        return jsonify(ok=True, gaps=agent.rerun_gaps(run_id, selected_only=scope == "selected"))
    except Exception as e:
        print(f"Gap analysis failed: {e}")
        return jsonify(ok=False, error=str(e)), 400


@app.get("/api/run/<int:run_id>/items")
def run_items(run_id):
    return jsonify(db.get_items(run_id))


@app.post("/api/select")
def select_items():
    data = request.get_json(force=True)
    db.set_selected([int(i) for i in data.get("ids", [])], bool(data.get("selected")))
    return jsonify(ok=True)


@app.post("/api/run/<int:run_id>/draft")
def make_draft(run_id):
    try:
        md = agent.draft_report(run_id)
        return jsonify(ok=True, draft=md)
    except Exception as e:
        print(f"Draft failed: {e}")
        return jsonify(ok=False, error=str(e)), 400


@app.get("/api/run/<int:run_id>/draft")
def get_draft(run_id):
    run = db.get_run(run_id) or abort(404)
    return jsonify(draft=run["draft"] or "")


@app.get("/run/<int:run_id>/export/<kind>.<fmt>")
def export(run_id, kind, fmt):
    run = db.get_run(run_id) or abort(404)
    name = (re.sub(r"[^A-Za-z0-9]+", "_", run["topic"])[:50].strip("_") or f"research_{run_id}") + f"_{kind}"
    if kind == "matrix" and fmt == "xlsx":
        items = db.get_items(run_id, selected_only=True) or db.get_items(run_id)
        data = matrix.build(run, items, json.loads(run.get("synthesis") or "[]"), json.loads(run.get("gaps") or "{}"))
        return Response(data, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})
    if kind == "draft":
        md = run["draft"] or abort(404)
    elif kind == "gaps":
        result = json.loads(run.get("gaps") or "{}")
        if not result.get("gaps"):
            abort(404)
        md = exporter.gaps_markdown(run, result, db.get_items(run_id))
    else:
        items = db.get_items(run_id, selected_only=True) or db.get_items(run_id)
        plan = json.loads(run["plan"] or "{}")
        md = exporter.evidence_markdown(run, items, [q["question"] for q in plan.get("questions", [])],
                                        json.loads(run.get("gaps") or "{}"))
    if fmt == "md":
        return Response(md, mimetype="text/markdown; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}.md"'})
    if fmt == "docx":
        return Response(exporter.md_to_docx(md),
                        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        headers={"Content-Disposition": f'attachment; filename="{name}.docx"'})
    abort(404)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    print(f"\n  CTENT Research Agent running at http://localhost:{port}   ({llm.label()})\n")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
