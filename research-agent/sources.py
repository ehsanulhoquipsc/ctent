"""Free research sources. Every search_* function returns a list of items in one shared shape."""
import html
import re
import threading
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote, urlparse

import requests

import config

_session = requests.Session()
_session.headers.update({"User-Agent": config.USER_AGENT})

# Minimum seconds between calls to each source (respects their published rate limits).
MIN_INTERVAL = {
    "openalex": 0.15, "semantic_scholar": 1.1, "crossref": 0.2, "arxiv": 3.1, "pubmed": 0.4,
    "doaj": 0.3, "core": 1.0, "openlibrary": 0.4, "googlebooks": 0.4, "wikipedia": 0.2,
    "worldbank": 0.5, "quran": 0.5, "hadith": 2.0, "web": 2.0, "news": 2.0,
    "unpaywall": 0.2, "fulltext": 0.3, "bdsites": 2.0,
}
_locks = {k: threading.Lock() for k in MIN_INTERVAL}
_last = {}


def _throttle(name):
    with _locks[name]:
        wait = MIN_INTERVAL[name] - (time.monotonic() - _last.get(name, -1e9))
        if wait > 0:
            time.sleep(wait)
        _last[name] = time.monotonic()


def _get(name, url, params=None, headers=None, as_json=True, retries=3, empty_on_404=False):
    err = None
    for attempt in range(retries):
        _throttle(name)
        try:
            r = _session.get(url, params=params, headers=headers, timeout=25)
        except requests.RequestException as e:
            err = e
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 404 and empty_on_404:
            return {} if as_json else ""
        if r.status_code == 429 or r.status_code >= 500:
            err = RuntimeError(f"HTTP {r.status_code} (rate limited or server busy)")
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code in (401, 403, 409):
            raise RuntimeError(f"HTTP {r.status_code} - needs an API key or daily quota used up")
        r.raise_for_status()
        return r.json() if as_json else r.text
    raise err


def _clean(s):
    if not s:
        return ""
    if isinstance(s, list):
        s = " ".join(str(x) for x in s if x)
    s = html.unescape(re.sub(r"<[^>]+>", " ", str(s)))
    return re.sub(r"\s+", " ", s).strip()


def _year(v):
    m = re.search(r"(1[5-9]\d\d|20\d\d)", str(v or ""))
    return m.group(1) if m else ""


def _item(source, type_, tier, title, authors=None, year=None, venue=None, abstract=None,
          url=None, doi=None, citations=None, pdf_url="", retracted=False, preprint=False, publisher=""):
    return {
        "pdf_url": pdf_url or "", "retracted": bool(retracted), "preprint": bool(preprint),
        "publisher": _clean(publisher),
        "source": source, "type": type_, "tier": tier,
        "title": _clean(title) or "(untitled)",
        "authors": [_clean(a) for a in (authors or []) if a and _clean(a)],
        "year": _year(year), "venue": _clean(venue), "abstract": _clean(abstract),
        "url": url or (f"https://doi.org/{doi}" if doi else ""),
        "doi": (doi or "").lower().replace("https://doi.org/", ""),
        "citations": int(citations) if isinstance(citations, (int, float)) else None,
    }


# ---------------------------------------------------------------- Academic papers

def _openalex_params(**kw):
    if config.OPENALEX_API_KEY:
        kw["api_key"] = config.OPENALEX_API_KEY
    return kw


def search_openalex(query, limit, lang="en"):
    data = _get("openalex", "https://api.openalex.org/works", _openalex_params(search=query, **{"per-page": min(limit, 50)}))
    return _parse_openalex(data.get("results", []))


def _parse_openalex(results):
    out = []
    for w in results:
        inv = w.get("abstract_inverted_index") or {}
        pos = {i: word for word, idxs in inv.items() for i in idxs}
        abstract = " ".join(pos[i] for i in sorted(pos))
        loc = w.get("primary_location") or {}
        venue = (loc.get("source") or {}).get("display_name")
        src = loc.get("source") or {}
        preprint = w.get("type") == "preprint" or src.get("type") == "repository"
        tier = "high" if w.get("type") in ("article", "review", "book", "book-chapter") and venue and not preprint else "medium"
        oa_url = (w.get("open_access") or {}).get("oa_url") or ""
        out.append(_item(
            "openalex", "book" if w.get("type") == "book" else "paper", tier,
            w.get("display_name") or w.get("title"),
            [(a.get("author") or {}).get("display_name") for a in w.get("authorships", [])],
            w.get("publication_year"), venue, abstract,
            oa_url or loc.get("landing_page_url") or w.get("doi"),
            w.get("doi"), w.get("cited_by_count"),
            pdf_url=loc.get("pdf_url") or (oa_url if oa_url.lower().endswith(".pdf") else ""),
            retracted=w.get("is_retracted"), preprint=preprint,
            publisher=src.get("host_organization_name")))
    return out


def search_semantic_scholar(query, limit, lang="en"):
    fields = "title,abstract,year,authors,venue,citationCount,url,externalIds,openAccessPdf,tldr"
    headers = {"x-api-key": config.S2_API_KEY} if config.S2_API_KEY else None
    data = _get("semantic_scholar", "https://api.semanticscholar.org/graph/v1/paper/search",
                {"query": query, "limit": min(limit, 100), "fields": fields}, headers)
    return [_parse_s2(p) for p in data.get("data") or [] if p.get("title")]


def _parse_s2(p):
    abstract = p.get("abstract") or (p.get("tldr") or {}).get("text") or ""
    venue = p.get("venue") or ""
    pdf = (p.get("openAccessPdf") or {}).get("url") or ""
    preprint = venue.lower() in ("arxiv", "arxiv.org", "biorxiv", "medrxiv", "ssrn")
    return _item("semantic_scholar", "paper", "high" if venue and not preprint else "medium",
                 p.get("title"), [a.get("name") for a in p.get("authors") or []], p.get("year"),
                 venue, abstract, pdf or p.get("url"), (p.get("externalIds") or {}).get("DOI"),
                 p.get("citationCount"), pdf_url=pdf, preprint=preprint)


def search_crossref(query, limit, lang="en"):
    params = {"query": query, "rows": min(limit, 50),
              "select": "DOI,title,author,issued,container-title,abstract,URL,is-referenced-by-count,type,publisher"}
    if config.CONTACT_EMAIL:
        params["mailto"] = config.CONTACT_EMAIL
    data = _get("crossref", "https://api.crossref.org/works", params)
    out = []
    for w in (data.get("message") or {}).get("items", []):
        authors = [f"{a.get('given', '')} {a.get('family', '')}".strip() or a.get("name", "")
                   for a in w.get("author", [])]
        parts = ((w.get("issued") or {}).get("date-parts") or [[None]])[0]
        wtype = w.get("type", "")
        tier = "high" if wtype in ("journal-article", "book", "book-chapter", "proceedings-article", "monograph") else "medium"
        out.append(_item(
            "crossref", "book" if wtype.startswith("book") or wtype == "monograph" else "paper", tier,
            w.get("title"), authors, parts[0] if parts else None,
            (w.get("container-title") or [w.get("publisher")])[0], w.get("abstract"),
            w.get("URL"), w.get("DOI"), w.get("is-referenced-by-count"),
            preprint=wtype == "posted-content", publisher=w.get("publisher")))
    return out


def search_arxiv(query, limit, lang="en"):
    words = [w for w in re.findall(r"[A-Za-z0-9\-]+", query)][:6]
    q = " AND ".join(f"all:{w}" for w in words) or f"all:{query}"
    text = _get("arxiv", "https://export.arxiv.org/api/query",
                {"search_query": q, "start": 0, "max_results": min(limit, 50), "sortBy": "relevance"},
                as_json=False)
    ns = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    out = []
    for e in ET.fromstring(text).findall("a:entry", ns):
        out.append(_item(
            "arxiv", "paper", "medium", e.findtext("a:title", "", ns),
            [a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)],
            e.findtext("a:published", "", ns), "arXiv preprint", e.findtext("a:summary", "", ns),
            e.findtext("a:id", "", ns), e.findtext("arxiv:doi", "", ns),
            pdf_url=e.findtext("a:id", "", ns).replace("/abs/", "/pdf/"), preprint=True))
    return out


def search_pubmed(query, limit, lang="en"):
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
    params = {"db": "pubmed", "term": query, "retmax": min(limit, 50), "retmode": "json", "sort": "relevance"}
    if config.CONTACT_EMAIL:
        params["email"] = config.CONTACT_EMAIL
    ids = _get("pubmed", base + "esearch.fcgi", params).get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    root = ET.fromstring(_get("pubmed", base + "efetch.fcgi",
                              {"db": "pubmed", "id": ",".join(ids), "retmode": "xml"}, as_json=False))
    out = []
    for art in root.findall(".//PubmedArticle"):
        pmid = art.findtext(".//MedlineCitation/PMID", "")
        t = art.find(".//ArticleTitle")
        doi = ""
        id_list = art.find("PubmedData/ArticleIdList")
        if id_list is not None:
            doi = next((i.text for i in id_list.findall("ArticleId") if i.get("IdType") == "doi"), "") or ""
        out.append(_item(
            "pubmed", "paper", "high", "".join(t.itertext()) if t is not None else "",
            [f"{a.findtext('ForeName', '')} {a.findtext('LastName', '')}".strip()
             for a in art.findall(".//AuthorList/Author") if a.findtext("LastName")],
            art.findtext(".//JournalIssue/PubDate/Year") or art.findtext(".//JournalIssue/PubDate/MedlineDate"),
            art.findtext(".//Journal/Title"),
            " ".join("".join(x.itertext()) for x in art.findall(".//Abstract/AbstractText")),
            f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/", doi))
    return out


def search_doaj(query, limit, lang="en"):
    data = _get("doaj", f"https://doaj.org/api/search/articles/{quote(query)}", {"pageSize": min(limit, 100)})
    out = []
    for r in data.get("results", []):
        b = r.get("bibjson", {})
        doi = next((i.get("id") for i in b.get("identifier", []) if (i.get("type") or "").lower() == "doi"), "")
        url = next((l.get("url") for l in b.get("link", []) if l.get("url")), "")
        out.append(_item("doaj", "paper", "high", b.get("title"), [a.get("name") for a in b.get("author", [])],
                         b.get("year"), (b.get("journal") or {}).get("title"), b.get("abstract"), url, doi))
    return out


def search_core(query, limit, lang="en"):
    data = _get("core", "https://api.core.ac.uk/v3/search/works", {"q": query, "limit": min(limit, 100)},
                {"Authorization": f"Bearer {config.CORE_API_KEY}"})
    out = []
    for w in data.get("results", []):
        links = w.get("links") or []
        url = w.get("downloadUrl") or next((l.get("url") for l in links if l.get("url")), "")
        out.append(_item("core", "paper", "medium", w.get("title"), [a.get("name") for a in w.get("authors") or []],
                         w.get("yearPublished"), w.get("publisher"), w.get("abstract"), url, w.get("doi"),
                         pdf_url=w.get("downloadUrl") or "", publisher=w.get("publisher")))
    return out


# ---------------------------------------------------------------- Books

def search_openlibrary(query, limit, lang="en"):
    data = _get("openlibrary", "https://openlibrary.org/search.json",
                {"q": query, "limit": min(limit, 50),
                 "fields": "key,title,subtitle,author_name,first_publish_year,publisher,first_sentence,subject"})
    out = []
    for d in data.get("docs", []):
        title = d.get("title", "") + (f": {d['subtitle']}" if d.get("subtitle") else "")
        desc = _clean(d.get("first_sentence"))
        if d.get("subject"):
            desc = (desc + " " if desc else "") + "Subjects: " + ", ".join(d["subject"][:10])
        out.append(_item("openlibrary", "book", "medium", title, d.get("author_name"), d.get("first_publish_year"),
                         (d.get("publisher") or [""])[0], desc, f"https://openlibrary.org{d.get('key', '')}"))
    return out


def search_googlebooks(query, limit, lang="en"):
    data = _get("googlebooks", "https://www.googleapis.com/books/v1/volumes",
                {"q": query, "maxResults": min(limit, 40), "printType": "books"})
    out = []
    for v in data.get("items", []):
        i = v.get("volumeInfo", {})
        title = i.get("title", "") + (f": {i['subtitle']}" if i.get("subtitle") else "")
        out.append(_item("googlebooks", "book", "medium", title, i.get("authors"), i.get("publishedDate"),
                         i.get("publisher"), i.get("description"), i.get("infoLink")))
    return out


# ---------------------------------------------------------------- Reference, data and reports

def search_wikipedia(query, limit, lang="en"):
    site = "bn" if lang == "bn" else "en"
    data = _get("wikipedia", f"https://{site}.wikipedia.org/w/api.php", {
        "action": "query", "format": "json", "generator": "search", "gsrsearch": query,
        "gsrlimit": min(limit, 5), "prop": "extracts|info", "exintro": 1, "explaintext": 1,
        "exlimit": "max", "inprop": "url"})
    pages = sorted((data.get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
    venue = "Wikipedia (Bangla)" if site == "bn" else "Wikipedia"
    return [_item("wikipedia", "reference", "low", p.get("title"), ["Wikipedia contributors"], None,
                  venue, p.get("extract"), p.get("fullurl")) for p in pages]


def search_worldbank(query, limit, lang="en"):
    data = _get("worldbank", "https://search.worldbank.org/api/v2/wds",
                {"format": "json", "qterm": query, "rows": min(limit, 50),
                 "fl": "display_title,docdt,abstracts,url,pdfurl,docty"})
    out = []
    for key, d in (data.get("documents") or {}).items():
        if not isinstance(d, dict) or key == "facets":
            continue
        abstract = d.get("abstracts")
        if isinstance(abstract, dict):
            abstract = abstract.get("cdata!") or " ".join(str(v) for v in abstract.values())
        out.append(_item("worldbank", "report", "medium", d.get("display_title"), ["World Bank"], d.get("docdt"),
                         f"World Bank {d.get('docty') or 'report'}", abstract, d.get("pdfurl") or d.get("url")))
    return out


# ---------------------------------------------------------------- Islamic sources

def search_quran(query, limit, lang="en"):
    data = _get("quran", f"https://api.alquran.cloud/v1/search/{quote(query)}/all/en.sahih", empty_on_404=True)
    if not isinstance(data.get("data"), dict):
        return []
    out = []
    for m in data["data"].get("matches", [])[:limit]:
        s = m.get("surah", {})
        ref = f"{s.get('number')}:{m.get('numberInSurah')}"
        text, venue = m.get("text"), "The Qur'an, Sahih International translation"
        if lang == "bn":  # add the Bangla translation (Muhiuddin Khan) of the same verse
            try:
                bn = _get("quran", f"https://api.alquran.cloud/v1/ayah/{ref}/bn.bengali").get("data", {}).get("text")
                if bn:
                    text = f"{bn} (English: {text})"
                    venue = "The Qur'an, Bangla translation (Muhiuddin Khan) & Sahih International"
            except Exception:
                pass
        out.append(_item("quran", "religious", "high", f"Qur'an {ref} (Surah {s.get('englishName', '')})",
                         [], None, venue, text, f"https://quran.com/{s.get('number')}/{m.get('numberInSurah')}"))
    return out


def _ddgs():
    try:
        from ddgs import DDGS
    except ImportError:
        from duckduckgo_search import DDGS
    return DDGS()


def search_hadith(query, limit, lang="en"):
    _throttle("hadith")
    site, venue = ("hadithbd.com", "HadithBD (Bangla)") if lang == "bn" else ("sunnah.com", "Sunnah.com")
    res = _ddgs().text(f"site:{site} {query}", max_results=min(limit, 15)) or []
    return [_item("hadith", "religious", "medium", r.get("title"), [], None, venue,
                  r.get("body"), r.get("href")) for r in res]


# ---------------------------------------------------------------- Web and news

_TRUSTED = (".gov", ".gov.au", ".gov.uk", ".edu", ".edu.au", ".ac.uk", ".int", ".un.org", "who.int", "oecd.org")


def _web_tier(url):
    host = urlparse(url or "").netloc.lower()
    return "medium" if host.endswith(_TRUSTED) else "low"


def search_web(query, limit, lang="en"):
    _throttle("web")
    res = _ddgs().text(query, max_results=min(limit, 20)) or []
    return [_item("web", "web", _web_tier(r.get("href")), r.get("title"), [], None,
                  urlparse(r.get("href", "")).netloc, r.get("body"), r.get("href")) for r in res]


def search_news(query, limit, lang="en"):
    _throttle("news")
    res = _ddgs().news(query, max_results=min(limit, 20)) or []
    return [_item("news", "news", "medium", r.get("title"), [], r.get("date"), r.get("source"),
                  r.get("body"), r.get("url") or r.get("href")) for r in res]


# ---------------------------------------------------------------- Bangladesh sources (site search, no API needed)

def _site_source(key, site, type_, tier, venue):
    def search(query, limit, lang="en"):
        _throttle("bdsites")
        res = _ddgs().text(f"site:{site} {query}", max_results=min(limit, 10)) or []
        return [_item(key, type_, tier, r.get("title"), [], None, venue, r.get("body"), r.get("href")) for r in res]
    search.__name__ = f"search_{key}"
    return search


search_banglajol = _site_source("banglajol", "banglajol.info", "paper", "high", "Bangladesh Journals Online (BanglaJOL)")
search_bbs = _site_source("bbs", "bbs.gov.bd", "report", "high", "Bangladesh Bureau of Statistics")
search_bangladesh_bank = _site_source("bangladesh_bank", "bb.org.bd", "report", "high", "Bangladesh Bank")
search_dailystar = _site_source("dailystar", "thedailystar.net", "news", "medium", "The Daily Star")
search_prothomalo = _site_source("prothomalo", "prothomalo.com", "news", "medium", "Prothom Alo")


# ---------------------------------------------------------------- Deeper research helpers

def crossref_lookup(doi):
    """Retraction status and publisher for one DOI (Crossref includes Retraction Watch data)."""
    params = {"mailto": config.CONTACT_EMAIL} if config.CONTACT_EMAIL else None
    w = _get("crossref", f"https://api.crossref.org/works/{quote(doi, safe='/')}", params, empty_on_404=True)
    w = (w or {}).get("message") or {}
    updates = w.get("updated-by") or []
    retracted = any((u.get("type") or "").lower() in ("retraction", "withdrawal", "removal") for u in updates)
    return {"retracted": retracted, "publisher": w.get("publisher") or ""}


def unpaywall_pdf(doi):
    """Free legal PDF link for a DOI. Unpaywall asks for a contact email (CONTACT_EMAIL)."""
    if not config.CONTACT_EMAIL or not doi:
        return ""
    data = _get("unpaywall", f"https://api.unpaywall.org/v2/{quote(doi, safe='/')}",
                {"email": config.CONTACT_EMAIL}, empty_on_404=True) or {}
    loc = data.get("best_oa_location") or {}
    return loc.get("url_for_pdf") or ""


def _trail_openalex(doi, limit):
    w = _get("openalex", f"https://api.openalex.org/works/doi:{doi}", _openalex_params(), empty_on_404=True)
    if not w.get("id"):
        return []
    wid = w["id"].rsplit("/", 1)[-1]
    out = []
    refs = [r.rsplit("/", 1)[-1] for r in w.get("referenced_works", [])][:50]
    if refs:
        data = _get("openalex", "https://api.openalex.org/works", _openalex_params(
            filter="openalex:" + "|".join(refs), sort="cited_by_count:desc", **{"per-page": limit}))
        out += [(it, "reference") for it in _parse_openalex(data.get("results", []))]
    data = _get("openalex", "https://api.openalex.org/works", _openalex_params(
        filter=f"cites:{wid}", sort="cited_by_count:desc", **{"per-page": limit}))
    out += [(it, "citing") for it in _parse_openalex(data.get("results", []))]
    return out


def _trail_s2(doi, limit):
    fields = "title,abstract,year,authors,venue,citationCount,url,externalIds,openAccessPdf"
    headers = {"x-api-key": config.S2_API_KEY} if config.S2_API_KEY else None
    out = []
    for kind, path, key in (("reference", "references", "citedPaper"), ("citing", "citations", "citingPaper")):
        data = _get("semantic_scholar", f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}/{path}",
                    {"fields": fields, "limit": 100}, headers, empty_on_404=True)
        papers = [d.get(key) or {} for d in data.get("data") or []]
        papers = sorted((p for p in papers if p.get("title")), key=lambda p: p.get("citationCount") or 0, reverse=True)
        out += [(_parse_s2(p), kind) for p in papers[:limit]]
    return out


def citation_trail(doi, limit):
    """Papers this DOI cites ("reference") and papers that cite it ("citing"), most cited first."""
    order = (_trail_openalex, _trail_s2) if config.OPENALEX_API_KEY else (_trail_s2, _trail_openalex)
    err = None
    for fn in order:
        try:
            res = fn(doi, limit)
            if res:
                return res
        except Exception as e:
            err = e
    if err:
        raise err
    return []


# ---------------------------------------------------------------- Registry
# mode: "questions" = searched once per sub-question, "topic" = once for the main topic,
#       "islamic" = searched with the Islamic keywords from the plan,
#       "bd" = main topic + first two sub-questions (English), "bd_bn" = same but in Bangla when Bangla mode is on.

SOURCES = {
    "openalex":         {"label": "OpenAlex", "group": "Academic papers", "fn": search_openalex, "mode": "questions",
                         "default": True, "needs": "OPENALEX_API_KEY (free, required since Feb 2026)"},
    "semantic_scholar": {"label": "Semantic Scholar", "group": "Academic papers", "fn": search_semantic_scholar, "mode": "questions", "default": True},
    "crossref":         {"label": "CrossRef", "group": "Academic papers", "fn": search_crossref, "mode": "questions", "default": True},
    "doaj":             {"label": "DOAJ (open-access journals)", "group": "Academic papers", "fn": search_doaj, "mode": "questions", "default": True},
    "arxiv":            {"label": "arXiv (preprints)", "group": "Academic papers", "fn": search_arxiv, "mode": "questions", "default": True},
    "pubmed":           {"label": "PubMed (health & life sciences)", "group": "Academic papers", "fn": search_pubmed, "mode": "questions", "default": False},
    "core":             {"label": "CORE (open-access full text)", "group": "Academic papers", "fn": search_core, "mode": "questions",
                         "default": True, "needs": "CORE_API_KEY (free)"},
    "openlibrary":      {"label": "Open Library", "group": "Books", "fn": search_openlibrary, "mode": "topic", "default": True},
    "googlebooks":      {"label": "Google Books", "group": "Books", "fn": search_googlebooks, "mode": "questions", "default": True},
    "worldbank":        {"label": "World Bank reports", "group": "Data & reports", "fn": search_worldbank, "mode": "questions", "default": True},
    "wikipedia":        {"label": "Wikipedia (+ Bangla Wikipedia)", "group": "Reference", "fn": search_wikipedia, "mode": "topic", "default": True},
    "quran":            {"label": "Qur'an (English + Bangla translation)", "group": "Islamic sources", "fn": search_quran, "mode": "islamic", "default": True},
    "hadith":           {"label": "Hadith (Sunnah.com + HadithBD in Bangla mode)", "group": "Islamic sources", "fn": search_hadith, "mode": "islamic", "default": True},
    "web":              {"label": "Web search (DuckDuckGo)", "group": "Web & news", "fn": search_web, "mode": "questions", "default": True},
    "news":             {"label": "News (DuckDuckGo)", "group": "Web & news", "fn": search_news, "mode": "topic", "default": True},
    "banglajol":        {"label": "BanglaJOL (Bangladesh journals)", "group": "Bangladesh sources", "fn": search_banglajol, "mode": "bd", "default": False},
    "bbs":              {"label": "Bangladesh Bureau of Statistics", "group": "Bangladesh sources", "fn": search_bbs, "mode": "bd", "default": False},
    "bangladesh_bank":  {"label": "Bangladesh Bank", "group": "Bangladesh sources", "fn": search_bangladesh_bank, "mode": "bd", "default": False},
    "dailystar":        {"label": "The Daily Star", "group": "Bangladesh sources", "fn": search_dailystar, "mode": "bd", "default": False},
    "prothomalo":       {"label": "Prothom Alo (prothomalo.com)", "group": "Bangladesh sources", "fn": search_prothomalo, "mode": "bd_bn", "default": False},
}


def is_available(key):
    if key == "openalex":
        return True  # works on a small keyless demo quota; a free key is recommended
    if key == "core":
        return bool(config.CORE_API_KEY)
    return True


def label(key):
    if key == "citation_trail":
        return "Citation trail"
    return SOURCES.get(key, {}).get("label", key)
