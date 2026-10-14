"""Downloads free, legal open-access PDFs and pulls out the parts worth reading:
the opening, methods, results, discussion, limitations and conclusion."""
import io
import re

import sources

MAX_BYTES = 15_000_000
MAX_PAGES = 40

SECTION_RE = re.compile(
    r"^[ \t]*(?:[IVX]+\.|\d+(?:\.\d+)*\.?)?[ \t]*"
    r"(abstract|introduction|background|literature review|related work|"
    r"materials and methods|methods?|methodology|research (?:design|methods?|methodology)|data and methods?|"
    r"results and discussion|results?|findings|discussion|limitations?(?: and future (?:work|research))?|"
    r"conclusions?(?: and (?:recommendations|implications|future work))?|references|bibliography)"
    r"[ \t]*:?[ \t]*$", re.I | re.M)

GROUPS = {"materials and methods": "methods", "method": "methods", "methods": "methods", "methodology": "methods",
          "research design": "methods", "research method": "methods", "research methods": "methods",
          "research methodology": "methods", "data and method": "methods", "data and methods": "methods",
          "results": "results", "result": "results", "findings": "results", "results and discussion": "results",
          "discussion": "discussion"}


def _group(head):
    h = head.lower().strip()
    if h.startswith("limitation"):
        return "limitations"
    if h.startswith("conclusion"):
        return "conclusion"
    return GROUPS.get(h)


def pdf_candidates(it):
    urls = []
    for u in (it.get("pdf_url"), it.get("url")):
        if not u:
            continue
        if "arxiv.org/abs/" in u:
            u = u.replace("/abs/", "/pdf/")
        if u.lower().endswith(".pdf") or "/pdf/" in u or u == it.get("pdf_url"):
            urls.append(u)
    return list(dict.fromkeys(urls))


def download_pdf(url):
    sources._throttle("fulltext")
    try:
        r = sources._session.get(url, timeout=40, stream=True, headers={"Accept": "application/pdf,*/*"})
    except Exception:
        return None
    if r.status_code != 200:
        return None
    data = bytearray()
    for chunk in r.iter_content(65536):
        data += chunk
        if len(data) > MAX_BYTES:
            return None
    return bytes(data) if data[:5] == b"%PDF-" else None


def pdf_text(data):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages = []
    for p in reader.pages[:MAX_PAGES]:
        try:
            pages.append(p.extract_text() or "")
        except Exception:
            continue
    text = "\n".join(pages)
    text = re.sub(r"-\n(?=[a-z])", "", text)        # re-join hyphenated words
    return re.sub(r"[ \t]+", " ", text)


def key_sections(text, cap=14000):
    heads = [(m.start(), m.group(1)) for m in SECTION_RE.finditer(text)]
    refs = [pos for pos, h in heads if h.lower() in ("references", "bibliography") and pos > len(text) * 0.4]
    if refs:
        text = text[:refs[-1]]
        heads = [(p, h) for p, h in heads if p < refs[-1]]
    found = [(p, h, _group(h)) for p, h in heads if _group(h)]
    if len({g for _, _, g in found}) < 2:  # no usable structure: take the start and the end
        return (text[:9000] + "\n[...]\n" + text[-4500:])[:cap] if len(text) > 13500 else text[:cap]
    parts, seen = ["[OPENING]\n" + text[:2500].strip()], set()
    positions = [p for p, _ in heads] + [len(text)]
    for pos, head, group in found:
        if group in seen:
            continue
        seen.add(group)
        end = next(p for p in positions if p > pos)
        parts.append(f"[{group.upper()}]\n" + text[pos:end][:2800].strip())
    return "\n\n".join(parts)[:cap]


def fetch(it):
    """Returns (excerpt, pdf_url) for an open-access paper, or (None, None)."""
    urls = pdf_candidates(it)
    if it.get("doi"):
        try:
            extra = sources.unpaywall_pdf(it["doi"])
            if extra:
                urls.append(extra)
        except Exception:
            pass
    for url in dict.fromkeys(urls):
        data = download_pdf(url)
        if not data:
            continue
        try:
            text = pdf_text(data)
        except Exception:
            continue
        if len(text) > 2500:
            return key_sections(text), url
    return None, None
