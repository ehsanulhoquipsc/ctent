"""Regression tests: one test per bug fixed in the November 2026 review. Run:  python tests/test_bugfixes.py"""
import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "bugfix.db")
os.environ.setdefault("GEMINI_API_KEY", "fake")
os.environ["LLM_MIN_INTERVAL"] = "0"

import agent, citations, config, db, exporter, fulltext, gaps, llm, matrix, sources  # noqa: E402

for k in sources.MIN_INTERVAL:
    sources.MIN_INTERVAL[k] = 0
db.init()


class FakeResp:
    def __init__(self, status=200, body=b"", js=None):
        self.status_code, self._body, self._js, self.closed = status, body, js, False

    def json(self):
        if self._js is None:
            raise ValueError("not json")
        return self._js

    @property
    def text(self):
        return self._body.decode()

    def iter_content(self, n):
        for i in range(0, len(self._body), n):
            yield self._body[i:i + n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.closed = True


# ---------------------------------------------------------------- sources

def test_errors_never_leak_keys():
    assert "SECRET" not in sources.scrub("url: /works?search=x&api_key=SECRET&mailto=me@x.com")
    assert "me@x.com" not in sources.scrub("...&email=me@x.com")
    orig = sources._session.get
    sources._session.get = lambda *a, **k: FakeResp(400)
    try:
        sources._get("openalex", "https://api.openalex.org/works", {"api_key": "SECRET"})
        assert False, "should raise"
    except RuntimeError as e:
        assert "SECRET" not in str(e) and "400" in str(e)
    finally:
        sources._session.get = orig
    lines = []
    db_log = db.append_log
    db.append_log = lambda rid, m: lines.append(m)
    try:
        run_id = db.create_run("x", "quick", [])
        orig_plan = agent.make_plan
        agent.make_plan = lambda *a: (_ for _ in ()).throw(RuntimeError("failed: GET /x?api_key=SECRET"))
        agent.run_research(run_id)
        agent.make_plan = orig_plan
        assert lines and not any("SECRET" in l for l in lines), lines
    finally:
        db.append_log = db_log


def test_unsafe_links_dropped():
    it = sources._item("web", "web", "low", "Bad", url="javascript:alert(1)", pdf_url="javascript:x")
    assert it["url"] == "" and it["pdf_url"] == ""
    assert sources._item("web", "web", "low", "Ok", url="https://a.org")["url"] == "https://a.org"


def test_doi_normalised():
    for raw in ("https://doi.org/10.1/ABC", "http://dx.doi.org/10.1/abc", "doi: 10.1/abc", "10.1/ABC"):
        assert sources._norm_doi(raw) == "10.1/abc", raw


def test_doaj_query_sanitised():
    seen = {}
    orig = sources._get
    sources._get = lambda name, url, *a, **k: seen.setdefault("url", url) and {"results": []}
    try:
        sources.search_doaj('impact: "zakat" (Bangladesh)/SMEs', 5)
    finally:
        sources._get = orig
    assert ":" not in seen["url"].split("/articles/")[1] and "%28" not in seen["url"]


def test_duckduckgo_retry_and_shared_limit():
    calls = {"n": 0}

    class Flaky:
        def text(self, q, max_results=10):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("202 Ratelimit")
            return [{"title": "T", "href": "https://x.gov.bd/a", "body": "b"}]

    orig_ddgs, orig_sleep = sources._ddgs, sources.time.sleep
    sources._ddgs, sources.time.sleep = (lambda: Flaky()), (lambda s: None)
    try:
        res = sources.search_web("q", 5)
    finally:
        sources._ddgs, sources.time.sleep = orig_ddgs, orig_sleep
    assert calls["n"] == 2 and res[0]["tier"] == "medium"  # retried once; .gov.bd now trusted
    assert all(k not in sources.MIN_INTERVAL for k in ("web", "news", "hadith", "bdsites"))


def test_openalex_without_key_searches_topic_once():
    plan = {"topic_query": "zakat poverty", "questions": [{"question": f"Q{i}", "query": f"q{i}"} for i in range(6)]}
    key = config.OPENALEX_API_KEY
    config.OPENALEX_API_KEY = ""
    try:
        jobs = agent._build_jobs(plan, ["openalex"], 5, "en")
    finally:
        config.OPENALEX_API_KEY = key
    assert len(jobs) == 1 and jobs[0][2] == "zakat poverty"


def test_pdf_download_closes_and_rejects_html():
    responses = []

    def fake_get(url, **k):
        r = FakeResp(200, b"<html>" + b"x" * 5000)
        responses.append(r)
        return r

    orig = sources._session.get
    sources._session.get = fake_get
    try:
        assert fulltext.download_pdf("https://a.org/paper") is None
        assert fulltext.download_pdf("javascript:x") is None
    finally:
        sources._session.get = orig
    assert responses and all(r.closed for r in responses)


# ---------------------------------------------------------------- AI answers

def test_ai_answer_shapes():
    orig = llm._call
    try:
        llm._call = lambda p, j: '```json\n[{"id": 0, "relevance": 4}]\n```'
        r = llm.json_call("x")
        assert isinstance(r, dict) and r["items"][0]["relevance"] == 4 and r["relevance"] == 4
        llm._call = lambda p, j: "Sure! Here it is: {\"claims\": []} hope that helps"
        assert llm.json_call("x") == {"claims": []}
        llm._call = lambda p, j: "no json at all"
        try:
            llm.json_call("x")
            assert False
        except ValueError:
            pass
    finally:
        llm._call = orig


def test_string_fields_not_split_into_letters():
    it = {"score": 0, "abstract": "Adoption raised output 23 percent in Dhaka."}
    agent._apply(it, {"findings": "Output rose.", "data_points": "23%", "quote": "  Adoption raised\noutput 23 "})
    assert it["findings"] == ["Output rose."] and it["data_points"] == ["23%"]
    assert it["relevance"] is None  # missing relevance = unknown, not 0
    assert it["quote"].startswith("Adoption raised output")
    agent._apply(it, ["not", "a", "dict"])  # ignored, no crash


def test_synthesis_ids_robust():
    items = [{"id": i, "question": "Q", "relevance": 4, "findings": [f"f{i}"], "data_points": [], "flags": [],
              "score": 1, "in_text": f"(A{i}, 2020)"} for i in range(3)]
    orig = llm.json_call
    llm.json_call = lambda p: {"claims": [{"claim": "C", "support": 1, "contradict": [-1, "2", 99]}]}
    try:
        out = agent.synthesize(items, {"questions": [{"question": "Q"}]}, "en", lambda m: None)
    finally:
        llm.json_call = orig
    c = out[0]["claims"][0]
    assert [x["id"] for x in c["support"]] == [1] and [x["id"] for x in c["contradict"]] == [2]


def test_daily_quota_fails_fast():
    import time
    calls = {"n": 0}

    class Models:
        def generate_content(self, **k):
            calls["n"] += 1
            raise RuntimeError("429 RESOURCE_EXHAUSTED quota GenerateRequestsPerDayPerProjectPerModel-FreeTier")

    class Client:
        models = Models()

    llm._client[0], llm._blocked_until[0] = Client(), 0.0
    provider = config.LLM_PROVIDER
    config.LLM_PROVIDER = "gemini"
    t0 = time.monotonic()
    try:
        for _ in range(3):
            try:
                llm.text_call("x")
            except llm.QuotaExhausted:
                pass
    finally:
        config.LLM_PROVIDER = provider
        llm._client[0], llm._blocked_until[0] = None, 0.0
    assert calls["n"] == 1 and time.monotonic() - t0 < 2  # no 200-second retry waits


def test_trail_does_not_relabel_search_results():
    a = {"source": "openalex", "title": "Same paper title here", "doi": "10.1/x", "url": "", "authors": [],
         "abstract": "", "tier": "high", "found_in": ["openalex"]}
    b = dict(a, source="semantic_scholar", via="Cited by (X, 2020)", found_in=["citation_trail"])
    merged = agent.dedupe([a, b])
    assert len(merged) == 1 and not merged[0].get("via") and "citation_trail" in merged[0]["found_in"]


# ---------------------------------------------------------------- citations

def test_harvard_fixes():
    items = [
        {"type": "book", "authors": [], "year": "2014", "title": "Leading Digital", "venue": "HBR Press", "url": "https://x"},
        {"type": "paper", "authors": ["A Bee", "C Dee", "E Eff"], "year": "2020", "title": "T", "venue": "J", "doi": "10.1/x"},
        {"type": "report", "authors": ["Australian Bureau of Statistics"], "year": "2021", "title": "Census", "venue": "ABS", "url": "https://abs"},
        {"type": "paper", "authors": ["Jean-Paul van der Berg"], "year": "2019", "title": "T2", "venue": "", "doi": ""},
        {"type": "paper", "authors": ["Abdur Rahman"], "year": "2022", "title": "Zakat B", "venue": "J2", "doi": "10.1/b"},
        {"type": "paper", "authors": ["A. Rahman"], "year": "2022", "title": "Zakat A", "venue": "J1", "doi": "10.1/a"},
    ]
    citations.apply(items)
    book, three, corp, particle, rb, ra = items
    assert book["citation"].startswith("*Leading Digital* (2014).")
    assert three["in_text"] == "(Bee, Dee and Eff, 2020)"
    assert corp["citation"].startswith("Australian Bureau of Statistics (2021)")
    assert particle["citation"] == "van der Berg, J.P. (2019) 'T2'."
    assert ra["in_text"] == "(Rahman, 2022a)" and rb["in_text"] == "(Rahman, 2022b)" and "(2022a)" in ra["citation"]


# ---------------------------------------------------------------- exports

def test_word_export_survives_bad_text_and_tables():
    md = ("# Title\x0c\n\n***Key*** point \x01 here\n\n---\n\n| Study | Year |\n|---|---|\n| Smith | 2020 |\n\n"
          "1) first\n\n##### Deep heading\n")
    from docx import Document
    doc = Document(io.BytesIO(exporter.md_to_docx(md)))
    assert len(doc.tables) == 1 and doc.tables[0].cell(1, 0).text == "Smith"
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "---" not in text and "#####" not in text and "\x01" not in text


def test_excel_export_survives_bad_text_and_formulas():
    import openpyxl
    run = {"lang": "en"}
    item = {"id": 1, "type": "paper", "tier": "high", "question": "Q", "title": "=HYPERLINK(\"x\")", "authors": [],
            "year": "2020", "venue": "J\x0b", "findings": ["bad\x02char"], "data_points": [], "flags": [],
            "in_text": "(T, 2020)", "citation": "C", "found_in": ["openalex"], "source": "openalex", "url": ""}
    wb = openpyxl.load_workbook(io.BytesIO(matrix.build(run, [item], [], {})))
    ws = wb.worksheets[0]
    assert ws.cell(2, 5).value == '=HYPERLINK("x")' and ws.cell(2, 5).data_type == "s"


def test_retracted_not_in_reference_list():
    run = {"lang": "en", "topic": "T"}
    good = {"id": 1, "type": "paper", "tier": "high", "question": "Q", "title": "Good", "findings": [], "data_points": [],
            "flags": [], "in_text": "(G, 2020)", "citation": "GOOD REF", "found_in": ["x"], "source": "x"}
    bad = dict(good, id=2, title="Bad", flags=["retracted"], citation="BAD REF")
    md = exporter.evidence_markdown(run, [good, bad], [])
    refs = md.split("## References")[1]
    assert "GOOD REF" in refs and "BAD REF" not in refs


# ---------------------------------------------------------------- app and database

def test_app_routes():
    import app as webapp
    c = webapp.app.test_client()
    run_id = db.create_run("Retry me", "quick", ["web"], "en", {"fulltext": False, "trail": False, "synthesis": False, "gaps": False})
    db.update_run(run_id, status="interrupted")
    assert c.get(f"/run/{run_id}/export/nonsense.docx").status_code == 404
    assert c.get(f"/run/{run_id}/export/draft.docx").status_code == 404
    assert c.post("/api/select", json={"ids": ["abc"], "selected": True}).status_code == 400
    assert "n_items" in c.get(f"/api/run/{run_id}").json
    orig = agent.run_research
    agent.run_research = lambda rid: None
    try:
        r = c.post(f"/run/{run_id}/retry")
    finally:
        agent.run_research = orig
    new_id = int(r.headers["Location"].rstrip("/").split("/")[-1])
    new = db.get_run(new_id)
    assert new_id != run_id and new["topic"] == "Retry me" and json.loads(new["options"])["gaps"] is False
    page = c.get(f"/run/{run_id}").get_data(as_text=True)
    assert "/retry" in page


def test_cli_does_not_interrupt_running_research():
    run_id = db.create_run("Busy", "quick", [])
    db.update_run(run_id, status="searching")
    db.init(mark_interrupted=False)
    assert db.get_run(run_id)["status"] == "searching"
    db.init()
    assert db.get_run(run_id)["status"] == "interrupted"


def test_regions_are_not_countries():
    assert gaps._norm_country("Global") == [] and gaps._norm_country("multiple countries") == []
    assert gaps._norm_country("Bangladesh, India") == ["Bangladesh", "India"]


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(f"OK - {len(tests)} bug-fix tests passed")
