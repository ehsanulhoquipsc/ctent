"""Source quality warnings: retracted papers, preprints that were not peer-reviewed, and journals worth checking.
The journal list is a heuristic warning only: it means "check this journal yourself", not "this is fake"."""
import re

import sources

PREPRINT_VENUES = ("arxiv", "ssrn", "biorxiv", "medrxiv", "research square", "preprints.org", "techrxiv",
                   "osf preprints", "psyarxiv", "socarxiv", "authorea", "zenodo", "researchgate")

CHECK_PUBLISHERS = ("omics", "scientific research publishing", "scirp", "world academy of science, engineering",
                    "waset", "science publishing group", "sciencepg", "iiste", "juniper publishers",
                    "austin publishing", "lupine publishers", "crimson publishers", "longdom", "imedpub",
                    "herald scholarly", "medcrave", "global journals inc", "sciencedomain", "journalijar",
                    "ijsr", "academia publishing")

_CHECK_RE = re.compile(r"\b(?:" + "|".join(re.escape(h) for h in CHECK_PUBLISHERS) + r")\b", re.I)

FLAG_PENALTY = {"retracted": 10.0, "check_journal": 0.6, "preprint": 0.2}


def flags_for(it):
    flags = []
    if it.get("retracted"):
        flags.append("retracted")
    venue, pub = (it.get("venue") or "").lower(), (it.get("publisher") or "").lower()
    if it.get("type") == "paper" and (it.get("preprint") or any(p in venue for p in PREPRINT_VENUES)):
        flags.append("preprint")
    if _CHECK_RE.search(venue) or _CHECK_RE.search(pub):
        flags.append("check_journal")
    return flags


def check(items, limit, log=None):
    """Looks up retraction status for the top papers with DOIs, then sets flags on every item."""
    checked = 0
    for it in items:
        if checked >= limit:
            break
        if it.get("type") != "paper" or not it.get("doi") or it.get("retracted"):
            continue
        checked += 1
        try:
            info = sources.crossref_lookup(it["doi"])
        except Exception:
            continue
        it["retracted"] = it.get("retracted") or info["retracted"]
        it["publisher"] = it.get("publisher") or info["publisher"]
    for it in items:
        it["flags"] = flags_for(it)
        it["score"] = it.get("score", 0) - sum(FLAG_PENALTY.get(f, 0) for f in it["flags"])
    return checked
