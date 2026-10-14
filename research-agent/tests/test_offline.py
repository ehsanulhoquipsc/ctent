"""Offline end-to-end test: fakes every source's API response and the AI, then runs the full pipeline,
the web routes and both exports.  Run:  python -m pytest tests  (or python tests/test_offline.py)"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["GEMINI_API_KEY"] = "fake"
os.environ["LLM_MIN_INTERVAL"] = "0"

import config, sources, llm, agent, db, citations, fulltext  # noqa: E402

for k in sources.MIN_INTERVAL:
    sources.MIN_INTERVAL[k] = 0

ABS = "Digital transformation increased innovation output by 23% across 1,200 SMEs between 2018 and 2023."
ARXIV = f"""<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
<id>http://arxiv.org/abs/2401.00001v1</id><published>2024-01-02T00:00:00Z</published>
<title>Digital Transformation and Innovation</title><summary>{ABS}</summary>
<author><name>Jane Q. Smith</name></author><author><name>Ali Khan</name></author></entry></feed>"""
PUBMED = f"""<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article>
<Journal><JournalIssue><PubDate><Year>2022</Year></PubDate></JournalIssue><Title>Health Informatics</Title></Journal>
<ArticleTitle>Digital health transformation</ArticleTitle><Abstract><AbstractText>{ABS}</AbstractText></Abstract>
<AuthorList><Author><LastName>Lee</LastName><ForeName>Min</ForeName></Author></AuthorList></Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="doi">10.1/pm</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>"""

FIXTURES = {
    "api.alquran.cloud/v1/ayah": {"code": 200, "data": {"text": "বলুন, যারা জানে এবং যারা জানে না; তারা কি সমান হতে পারে?"}},
    "bn.wikipedia.org": {"query": {"pages": {"1": {"index": 1, "title": "ডিজিটাল রূপান্তর",
        "extract": "ডিজিটাল রূপান্তর হলো প্রতিষ্ঠানে ডিজিটাল প্রযুক্তির ব্যবহার।", "fullurl": "https://bn.wikipedia.org/wiki/x"}}}},
    "api.openalex.org": {"results": [{"display_name": "Digital Transformation and Innovation", "type": "article",
        "publication_year": 2023, "doi": "https://doi.org/10.1/abc", "cited_by_count": 150,
        "abstract_inverted_index": {"Digital": [0], "transformation": [1], "boosts": [2], "innovation": [3]},
        "authorships": [{"author": {"display_name": "Jane Q. Smith"}}],
        "primary_location": {"source": {"display_name": "Journal of Innovation"}, "landing_page_url": "https://x.org/a"},
        "open_access": {"oa_url": None}}]},
    "api.semanticscholar.org": {"data": [{"title": "Digital transformation and innovation", "abstract": ABS,
        "year": 2023, "authors": [{"name": "Jane Smith"}], "venue": "J Innov", "citationCount": 140,
        "url": "https://s2/1", "externalIds": {"DOI": "10.1/ABC"}}]},
    "api.crossref.org": {"message": {"items": [{"DOI": "10.2/xyz", "title": ["SME digital adoption"],
        "author": [{"given": "Omar", "family": "Farooq"}], "issued": {"date-parts": [[2021, 5]]},
        "container-title": ["Small Business Economics"], "abstract": f"<jats:p>{ABS}</jats:p>",
        "URL": "https://doi.org/10.2/xyz", "is-referenced-by-count": 40, "type": "journal-article"}]}},
    "export.arxiv.org": ARXIV,
    "esearch.fcgi": {"esearchresult": {"idlist": ["123"]}},
    "efetch.fcgi": PUBMED,
    "doaj.org": {"results": [{"bibjson": {"title": "Open access study on digital SMEs", "abstract": ABS, "year": "2020",
        "author": [{"name": "Sara Ahmed"}], "journal": {"title": "OA Journal"},
        "identifier": [{"type": "doi", "id": "10.3/oa"}], "link": [{"url": "https://oa.org/1"}]}}]},
    "openlibrary.org": {"docs": [{"key": "/works/OL1W", "title": "Leading Digital", "author_name": ["George Westerman"],
        "first_publish_year": 2014, "publisher": ["Harvard Business Review Press"], "subject": ["Management", "Technology"]}]},
    "www.googleapis.com": {"items": [{"volumeInfo": {"title": "The Digital Transformation Playbook", "authors": ["David L. Rogers"],
        "publishedDate": "2016-04-05", "publisher": "Columbia University Press", "description": ABS, "infoLink": "https://books.google/x"}}]},
    "en.wikipedia.org": {"query": {"pages": {"1": {"index": 1, "title": "Digital transformation",
        "extract": "Digital transformation is the adoption of digital technology by an organization.", "fullurl": "https://en.wikipedia.org/wiki/Digital_transformation"}}}},
    "search.worldbank.org": {"documents": {"D1": {"display_title": "Digital SMEs in South Asia", "docdt": "2022-03-01",
        "abstracts": {"cdata!": ABS}, "pdfurl": "https://wb.org/1.pdf", "docty": "Working Paper"}, "facets": {}}},
    "api.alquran.cloud": {"code": 200, "data": {"count": 1, "matches": [{"text": "Are those who know equal to those who do not know?",
        "numberInSurah": 9, "surah": {"number": 39, "englishName": "Az-Zumar"}}]}},
}


TRAIL_PAPER = {"title": "Foundations of digital innovation in small firms", "abstract": ABS, "year": 2015,
               "authors": [{"name": "Rita Gomez"}], "venue": "Research Policy", "citationCount": 900,
               "url": "https://s2/ref", "externalIds": {"DOI": "10.9/ref"}}
CITING_PAPER = {"title": "Digital SMEs revisited: a survey", "abstract": ABS, "year": 2025,
                "authors": [{"name": "Tom Lee"}], "venue": "OMICS Journal of Business", "citationCount": 3,
                "url": "https://s2/cite", "externalIds": {"DOI": "10.9/cite"}}
FIXTURES = {
    "api.crossref.org/works/10.2": {"message": {"publisher": "Springer", "updated-by": [{"type": "retraction", "DOI": "10.2/r"}]}},
    "api.crossref.org/works/10.": {"message": {"publisher": "Elsevier", "updated-by": []}},
    "api.semanticscholar.org/graph/v1/paper/DOI:": {"data": [{"citedPaper": TRAIL_PAPER, "citingPaper": CITING_PAPER}]},
    **FIXTURES,
}

FULLTEXT = "[METHODS]\nMixed-methods: survey of 300 manufacturing SMEs in Dhaka plus 12 interviews.\n[RESULTS]\nAdoption raised output 23%."


def fake_get(name, url, params=None, headers=None, as_json=True, retries=3, empty_on_404=False):
    for key, val in FIXTURES.items():
        if key in url:
            return json.loads(json.dumps(val)) if as_json and not isinstance(val, str) else val
    raise RuntimeError(f"no fixture for {url}")


class FakeDDGS:
    def text(self, q, max_results=10):
        if q.startswith("site:hadithbd.com"):
            return [{"title": "জ্ঞান অর্জন - হাদিসবিডি", "href": "https://www.hadithbd.com/hadith/1", "body": "জ্ঞান অর্জন করা প্রত্যেক মুসলিমের উপর ফরজ।"}]
        if q.startswith("site:sunnah.com"):
            return [{"title": "Seeking knowledge - Sunan Ibn Majah", "href": "https://sunnah.com/ibnmajah:224", "body": "Seeking knowledge is an obligation upon every Muslim."}]
        return [{"title": "SME digital transformation report", "href": "https://www.industry.gov.au/dt", "body": ABS}]

    def news(self, q, max_results=10):
        return [{"title": "SMEs race to digitise", "url": "https://news.example.com/1", "body": ABS, "date": "2026-09-01", "source": "ABC News"}]


def fake_json_call(prompt):
    bn = "প্রমিত" in prompt
    if "research planner" in prompt:
        q1 = "ক্ষুদ্র ব্যবসায় ডিজিটাল উদ্ভাবনের চালিকাশক্তি কী?" if bn else "What drives digital innovation in SMEs?"
        return {"topic_query": "SME digital transformation", "topic_query_bn": "ডিজিটাল রূপান্তর",
                "questions": [{"question": q1, "query": "SME digital innovation drivers", "query_bn": "ডিজিটাল উদ্ভাবন"},
                              {"question": "What data exists on adoption?", "query": "SME digital adoption statistics", "query_bn": "ডিজিটাল পরিসংখ্যান"}],
                "islamic_keywords": ["knowledge"], "islamic_keywords_bn": ["জ্ঞান"]}
    if "FULL TEXT" in prompt:
        return {"relevance": 5, "findings": ["পূর্ণ লেখা: উৎপাদন ২৩% বেড়েছে।" if bn else "Full text: output rose 23% after adoption."],
                "data_points": ["300 SMEs surveyed in Dhaka"], "method": "Mixed-methods survey + interviews",
                "sample": "300 manufacturing SMEs, Dhaka", "limitations": "Self-reported data", "quote": "Adoption raised output 23%",
                "future_research": "Longitudinal studies are needed", "method_type": "mixed methods", "country": "Bangladesh"}
    if "find RESEARCH GAPS" in prompt:
        return {"gaps": [
            {"title": "ঢাকার বাইরে প্রমাণ কম" if bn else "Few studies outside capital cities", "type": "contextual", "priority": "high",
             "description": "Most evidence is urban.", "signal": "2 of 9 sources", "evidence": [0, 1, 99, "x"],
             "research_question": "How does digital adoption affect rural SMEs?", "method": "Survey of 400 rural SMEs"},
            {"title": "No experiments", "type": "nonsense-type", "priority": "urgent", "description": "", "evidence": []},
            {"title": "", "type": "empirical"}]}
    if "CLAIMS" in prompt:
        n = prompt.count("\n[") + 1
        return {"claims": [{"claim": "দাবি" if bn else "Digital adoption raises innovation", "support": list(range(min(n, 3))),
                            "contradict": [n - 1] if n > 3 else [], "note": "Different samples"}]}
    n = prompt.count("[id=")
    return {"items": [{"id": i, "relevance": 4, "findings": ["ডিজিটাল প্রযুক্তি উদ্ভাবন বাড়িয়েছে।" if bn else "Digital tools raised innovation output."],
                       "data_points": ["23% innovation increase across 1,200 SMEs (2018-2023)"],
                       "quote": "increased innovation output by 23%"} for i in range(n)]}


def setup():
    sources._get = fake_get
    sources._ddgs = lambda: FakeDDGS()
    fulltext.fetch = lambda it: (FULLTEXT, it["pdf_url"]) if it.get("pdf_url") else (None, None)
    llm.json_call = fake_json_call
    llm.text_call = lambda p: "# Draft\n\n## Introduction\n\nDigital tools raise innovation (Smith et al., 2023)."
    db.init()


def test_each_source_parses():
    setup()
    for key, s in sources.SOURCES.items():
        if key == "core":
            continue
        if s["group"] == "Bangladesh sources":
            assert s["fn"]("digital", 3), key
            continue
        res = s["fn"]("digital transformation", 5)
        assert res, f"{key} returned nothing"
        assert res[0]["title"] and res[0]["title"] != "(untitled)", key


def test_key_sections():
    body = "Intro text. " * 300
    text = (f"Title\nAbstract\n{body}\n1. Introduction\n{body}\n2. Methods\nWe surveyed 300 firms. {body}\n"
            f"3. Results\nOutput rose. {body}\n4. Discussion\n{body}\nLimitations\nSmall sample.\n5. Conclusion\nDone.\n"
            f"References\n" + "Smith 2020. " * 400)
    out = fulltext.key_sections(text)
    for tag in ("[METHODS]", "[RESULTS]", "[DISCUSSION]", "[LIMITATIONS]", "[CONCLUSION]"):
        assert tag in out, tag
    assert "Smith 2020" not in out and len(out) <= 14000


def test_gap_analysis():
    import gaps
    assert gaps.countries_in("A survey of SMEs in Bangladesh and the UK") == ["Bangladesh", "United Kingdom"]
    assert gaps.countries_in("Let us consider firms") == []
    assert gaps.countries_in("বাংলাদেশে ক্ষুদ্র ব্যবসা") == ["Bangladesh"]
    assert gaps.classify_method({"abstract": "We ran a randomised field experiment"}) == "experiment"
    assert gaps.classify_method({"method_type": "case study", "abstract": "survey"}) == "case study"
    items = []
    for i in range(14):
        items.append({"id": i, "type": "paper", "tier": "high", "relevance": 4, "flags": [], "fulltext": i < 2,
                      "question": "Q1" if i < 12 else "Q2", "year": str(2010 + i % 8), "title": f"Paper {i}",
                      "abstract": "We surveyed managers using a questionnaire in China.", "findings": ["x"],
                      "data_points": [], "in_text": f"(A{i}, 2015)", "citation": f"A{i} (2015)",
                      "limitations": "Cross-sectional data" if i < 3 else "", "future": ""})
    plan = {"questions": [{"question": "Q1"}, {"question": "Q2"}], "topic_query": "digital SMEs Bangladesh"}
    synth = [{"question": "Q1", "claims": [{"claim": "Adoption raises profit", "consensus": "contested",
                                             "support": [1, 2], "contradict": [3, 4], "note": "Different sectors"}]}]
    st = gaps.analyse(items, plan, synth, "Digital SMEs in Bangladesh", "en")
    assert [c["thin"] for c in st["coverage"]] == [False, True]
    assert st["methods"][0] == ("survey", 14) and "experiment" in st["missing_methods"]
    assert st["topic_countries"] == [{"country": "Bangladesh", "n": 0}] and st["countries"][0] == ("China", 14)
    assert st["years"]["recent"] == 0 and len(st["stated"]) == 3
    types = [g["type"] for g in gaps.rule_gaps(st, "en")]
    for t in ("empirical", "methodological", "contextual", "temporal", "conflicting", "author"):
        assert t in types, t
    bn = gaps.rule_gaps(st, "bn")
    assert any("বাংলাদেশ" in g["title"] or "Bangladesh" in g["title"] for g in bn)


def test_citations():
    it = {"type": "paper", "authors": ["Jane Q. Smith", "Ali Khan"], "year": "2023", "title": "T", "venue": "J", "doi": "10.1/x"}
    assert citations.in_text(it) == "(Smith and Khan, 2023)"
    assert citations.harvard(it) == "Smith, J.Q. and Khan, A. (2023) 'T', *J*. doi: 10.1/x."
    assert citations.authors_str(["Farooq, Omar"]) == "Farooq, O."


def test_full_pipeline_and_web():
    setup()
    import app as webapp
    chosen = [k for k, s in sources.SOURCES.items() if s["default"]]
    run_id = db.create_run("Digital transformation in SMEs", "quick", chosen)
    agent.run_research(run_id)
    run = db.get_run(run_id)
    assert run["status"] == "done", run["log"]
    items = db.get_items(run_id)
    assert len(items) >= 10
    merged = [i for i in items if len(i["found_in"]) > 1]
    assert merged, "OpenAlex + Semantic Scholar duplicate (same DOI) should merge"
    assert any(i["data_points"] for i in items)
    assert any(i["source"] == "quran" for i in items)

    c = webapp.app.test_client()
    assert c.get("/").status_code == 200
    assert c.get(f"/run/{run_id}").status_code == 200
    assert c.get(f"/api/run/{run_id}/items").json
    ids = [i["id"] for i in items[:5]]
    assert c.post("/api/select", json={"ids": ids, "selected": True}).json["ok"]
    assert len(db.get_items(run_id, selected_only=True)) == 5
    r = c.post(f"/api/run/{run_id}/draft").json
    assert r["ok"] and "## References" in r["draft"]
    for path in (f"/run/{run_id}/export/evidence.md", f"/run/{run_id}/export/evidence.docx",
                 f"/run/{run_id}/export/draft.docx", f"/run/{run_id}/export/matrix.xlsx"):
        resp = c.get(path)
        assert resp.status_code == 200 and len(resp.data) > 500, path
    # new features
    items = db.get_items(run_id)
    assert any(i["via"] for i in items), "citation trail papers missing"
    assert any("retracted" in i["flags"] for i in items), "retraction not flagged"
    assert any("check_journal" in i["flags"] for i in items), "journal warning missing"
    merged = next(i for i in items if "arxiv" in i["found_in"])  # arXiv copy of a journal paper: not a preprint
    assert "preprint" not in merged["flags"] and len(merged["found_in"]) > 1
    import quality
    assert quality.flags_for({"type": "paper", "preprint": True, "venue": "arXiv preprint"}) == ["preprint"]
    assert any(i["fulltext"] and i["method"] for i in items), "full text not read"
    synth = c.get(f"/api/run/{run_id}/synthesis").json
    assert synth and synth[0]["claims"][0]["support"], "synthesis empty"
    import io, openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(c.get(f"/run/{run_id}/export/matrix.xlsx").data))
    assert len(wb.sheetnames) == 6 and wb.worksheets[0].max_row > 3, wb.sheetnames
    draft = c.post(f"/api/run/{run_id}/draft").json["draft"]
    assert "## References" in draft
    # research gaps
    g = c.get(f"/api/run/{run_id}/gaps").json
    assert g["ai"] and g["stats"]["coverage"] and len(g["gaps"]) == 2, g.get("gaps")
    first = g["gaps"][0]
    assert first["priority"] == "high" and first["research_question"] and len(first["evidence"]) == 2
    assert g["gaps"][1]["type"] == "empirical" and g["gaps"][1]["priority"] == "medium"
    assert any(i["future"] and i["country"] == "Bangladesh" for i in db.get_items(run_id))
    brief = c.get(f"/run/{run_id}/export/gaps.md").get_data(as_text=True)
    assert "Research gaps brief" in brief and "How does digital adoption" in brief and "## References" in brief
    assert c.get(f"/run/{run_id}/export/gaps.docx").status_code == 200
    assert "Research gaps" in c.get(f"/run/{run_id}/export/evidence.md").get_data(as_text=True)
    wb = openpyxl.load_workbook(io.BytesIO(c.get(f"/run/{run_id}/export/matrix.xlsx").data))
    assert "Research gaps" in wb.sheetnames and "Coverage" in wb.sheetnames
    r = c.post(f"/api/run/{run_id}/gaps", json={"scope": "selected"}).json
    assert r["ok"] and r["gaps"]["scope"] == "selected"
    saved_llm = llm.enabled
    llm.enabled = lambda: False
    try:
        r = c.post(f"/api/run/{run_id}/gaps", json={"scope": "all"}).json
        assert r["ok"] and not r["gaps"]["ai"]
    finally:
        llm.enabled = saved_llm
    return run, items


def test_bangla_mode():
    setup()
    import app as webapp
    chosen = [k for k, s in sources.SOURCES.items() if s["default"]]
    run_id = db.create_run("বাংলাদেশে ক্ষুদ্র ব্যবসায় ডিজিটাল রূপান্তর", "quick", chosen, "bn")
    agent.run_research(run_id)
    run = db.get_run(run_id)
    assert run["status"] == "done", run["log"]
    items = db.get_items(run_id)
    assert any(i["venue"] == "Wikipedia (Bangla)" for i in items)
    assert any("HadithBD" in i["venue"] for i in items)
    assert any("বলুন" in i["abstract"] for i in items if i["source"] == "quran")
    assert any("ডিজিটাল প্রযুক্তি" in f for i in items for f in i["findings"])
    assert "সম্পন্ন" in run["log"]
    c = webapp.app.test_client()
    assert "নতুন গবেষণা" in c.get("/?ui=bn").get_data(as_text=True)
    assert c.get(f"/run/{run_id}").status_code == 200
    c.post("/api/select", json={"ids": [i["id"] for i in items[:4]], "selected": True})
    assert c.post(f"/api/run/{run_id}/draft").json["draft"].count("তথ্যসূত্র") == 1
    md = c.get(f"/run/{run_id}/export/evidence.md").get_data(as_text=True)
    assert "প্রমাণ-সংকলন" in md and "মূল তথ্য" in md
    docx = c.get(f"/run/{run_id}/export/evidence.docx")
    assert docx.status_code == 200
    return run_id, docx.data


if __name__ == "__main__":
    test_key_sections()
    test_gap_analysis()
    test_bangla_mode()
    print("OK - Bangla mode works")
    test_each_source_parses()
    test_citations()
    run, items = test_full_pipeline_and_web()
    print(run["log"])
    print(f"OK - {len(items)} cards; all sources parsed; draft and exports work")
