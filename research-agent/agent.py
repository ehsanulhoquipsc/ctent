"""The research pipeline:
plan -> search -> de-duplicate -> rank -> citation trail -> quality checks -> read full text -> extract evidence
-> agreement/contradiction synthesis -> save cards -> research gaps -> (later) draft.

Supports English and Bangla (lang="bn"): academic databases are always searched in English, while Bangla web,
news, Wikipedia and hadith sources are searched in Bangla, and findings and drafts are written in Bangla."""
import json
import math
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

import citations
import config
import db
import fulltext
import gaps as gapfinder
import llm
import quality
import sources
from translations import a as msg

STOP = set("""the a an of and or in on for to with by from is are was were be been as at that this these those what
how why which who whom does do did into about between their its it vs versus than then there over under within
among using use based study role effect effects impact এবং ও এর কি কী কে যে এই সেই করে হয় হতে জন্য থেকে মধ্যে
উপর একটি বা না""".split())

BANGLA = re.compile(r"[ঀ-৿]")

PLAN_PROMPT = """You are a senior research planner.
Main topic (may be written in English or Bangla): "{topic}"

1. Break the topic into {n} focused sub-questions that together give deep, balanced coverage:
   background and definitions, theory, current evidence, statistics and data, debates and opposing views,
   real-world case studies, and gaps for future research.
2. For each sub-question write "query": a short ENGLISH keyword search (3-6 words) for academic databases,
   and "query_bn": a short BANGLA keyword search (2-5 words) for Bangla web and news search.
3. "topic_query": the main topic as a short English keyword search; "topic_query_bn": the same in Bangla.
4. If the topic has a religious, ethical, social or Islamic angle, give up to 3 single ENGLISH keywords
   ("islamic_keywords", e.g. "justice") and the same in Bangla ("islamic_keywords_bn"). Otherwise empty lists.
{lang_rule}
Return JSON only:
{{"topic_query": "...", "topic_query_bn": "...",
  "questions": [{{"question": "...", "query": "...", "query_bn": "..."}}],
  "islamic_keywords": ["..."], "islamic_keywords_bn": ["..."]}}"""

EXTRACT_PROMPT = """Research topic: "{topic}"
For each source below, judge how relevant it is to its sub-question and extract evidence from the given text ONLY.
Never invent facts, numbers or quotes that are not in the text. Leave a field empty if the text does not say.
{lang_rule}
Return JSON only:
{{"items": [{{"id": <id>, "relevance": <0-5>,
  "findings": ["1-3 key findings, paraphrased in your own words"],
  "data_points": ["every number/statistic with its context, e.g. '42% of SMEs adopted cloud tools by 2023'"],
  "method": "research design/method if stated (e.g. 'survey', 'case study', 'systematic review'), else empty",
  "sample": "sample size, population, country or context if stated, else empty",
  "limitations": "limitations if stated, else empty",
  "future_research": "future research the authors call for, if stated, else empty",
  "method_type": "one of: {method_types}, or empty",
  "country": "country or countries studied, in English, or empty",
  "quote": "one short exact phrase copied from the text (under 25 words), or empty"}}]}}

SOURCES:
{sources}"""

FULLTEXT_PROMPT = """Research topic: "{topic}"
Sub-question this source was found for: "{question}"
Below are key sections of the FULL TEXT of: "{title}" ({year}).
Extract evidence from this text ONLY. Never invent facts, numbers or quotes. Leave a field empty if not stated.
{lang_rule}
Return JSON only:
{{"relevance": <0-5>,
  "findings": ["3-5 specific key findings relevant to the topic, paraphrased"],
  "data_points": ["every important number/statistic with its context"],
  "method": "research design and method, e.g. 'mixed-methods: survey of SMEs + 12 interviews'",
  "sample": "sample size, population, country/context and period",
  "limitations": "limitations the authors state",
  "future_research": "future research directions the authors suggest, or empty",
  "method_type": "one of: {method_types}, or empty",
  "country": "country or countries studied, in English, or empty",
  "quote": "one short exact phrase copied from the text (under 25 words), or empty"}}

TEXT:
{text}"""

SYNTH_PROMPT = """Sub-question: "{question}"
Below are findings from different sources, each with an id. Identify the 3-8 most important CLAIMS these sources
make about the sub-question. For each claim, list the ids of sources that SUPPORT it and the ids of sources that
CONTRADICT or seriously qualify it. Only use what the findings say. If sources disagree, explain why in "note"
(different countries, methods, periods, samples...).
{lang_rule}
Return JSON only:
{{"claims": [{{"claim": "...", "support": [ids], "contradict": [ids], "note": "..."}}]}}

FINDINGS:
{cards}"""

DRAFT_PROMPT = """Write a well-structured academic research report draft on: "{topic}"

Rules:
- Use ONLY the evidence cards below. Do not add facts from elsewhere.
- Cite every claim with the Harvard in-text citation shown on its card, e.g. (Smith, 2021), copied exactly.
- Structure: # Title, ## Introduction, then thematic ## sections that synthesise across sources (compare, contrast,
  note agreement and disagreement), ## Discussion, ## Conclusion, ## Gaps and Further Research.
- Use the CONSENSUS MAP to show where evidence is strong, mixed or rests on a single source, and discuss why
  sources disagree. Mention methods and limitations where they matter.
- Never cite a source marked RETRACTED. Describe preprints as not yet peer-reviewed.
- Build the "Gaps and Further Research" section from the RESEARCH GAPS list: explain each important gap,
  cite the sources that show it, and end with the suggested research questions.
- Formal academic tone, paraphrase rather than quote. Markdown only. Do NOT write a reference list.
{lang_rule}
CONSENSUS MAP:
{consensus}

RESEARCH GAPS (from this collection of sources):
{gaps}

EVIDENCE CARDS:
{cards}"""

LANG_RULES = {
    "plan": {"en": "Write each \"question\" in English.",
             "bn": "Write each \"question\" in clear, formal Bangla (প্রমিত বাংলা). Keep \"query\" in English."},
    "extract": {"en": "Write findings, data_points, method, sample and limitations in English.",
                "bn": "Write findings, data_points, method, sample and limitations in formal Bangla (প্রমিত বাংলা), "
                      "even if the source is English. Keep numbers, names and dates exact; technical terms may stay "
                      "in English in brackets. The quote must stay in the source's original language."},
    "synth": {"en": "Write claims and notes in English.",
              "bn": "Write claims and notes in formal Bangla (প্রমিত বাংলা)."},
    "draft": {"en": "Write in British/Australian academic English.",
              "bn": "Write the ENTIRE report, including the title and all headings, in formal academic Bangla "
                    "(প্রমিত বাংলা). Technical terms may be followed by the English term in brackets. "
                    "Keep the in-text citations exactly as shown on the cards (in English)."},
}
REF_HEADING = {"en": "References", "bn": "তথ্যসূত্র (References)"}
METHOD_LIST = ", ".join(f'"{m}"' for m in gapfinder.METHOD_TYPES)


def _tokens(s):
    return {w for w in re.findall(r"[a-z0-9ঀ-৿]+", (s or "").lower()) if w not in STOP and len(w) > 2}


def _first_sentences(text, n=2):
    parts = re.split(r"(?<=[.!?।])\s+", (text or "").strip())
    return [" ".join(parts[:n])[:500]] if text else []


def _s(v):
    return v.strip() if isinstance(v, str) else ""


def _list(v):
    return [x for x in v or [] if isinstance(x, str) and x.strip()]


# ---------------------------------------------------------------- 1. Plan

def make_plan(topic, depth, lang, log):
    n = config.DEPTHS[depth]["max_questions"]
    if llm.enabled():
        try:
            p = llm.json_call(PLAN_PROMPT.format(topic=topic, n=n, lang_rule=LANG_RULES["plan"][lang]))
            qs = [q for q in p.get("questions", []) if q.get("question") and q.get("query")][:n]
            if qs:
                tq = p.get("topic_query") or topic
                tq_bn = p.get("topic_query_bn") or (topic if BANGLA.search(topic) else "")
                for q in qs:
                    q.setdefault("query_bn", "")
                return {"topic_query": tq, "topic_query_bn": tq_bn,
                        "questions": [{"question": topic, "query": tq, "query_bn": tq_bn}] + qs,
                        "islamic_keywords": [k for k in p.get("islamic_keywords", []) if k][:3],
                        "islamic_keywords_bn": [k for k in p.get("islamic_keywords_bn", []) if k][:3]}
        except Exception as e:
            log(msg(lang, "plan_failed", e=str(e)[:150]))
    if BANGLA.search(topic):
        log(msg(lang, "bn_no_ai"))
    angles = ["", "systematic review", "statistics data", "challenges", "case study",
              "future trends", "policy", "theoretical framework", "impact", "history"]
    qs = [{"question": f"{topic} - {a}" if a else topic, "query": f"{topic} {a}".strip(),
           "query_bn": topic if BANGLA.search(topic) else ""} for a in angles[:n + 1]]
    keywords = sorted(_tokens(topic), key=len, reverse=True)[:2]
    bn_kw = keywords if BANGLA.search(topic) else []
    en_kw = [k for k in keywords if not BANGLA.search(k)]
    return {"topic_query": topic, "topic_query_bn": topic if BANGLA.search(topic) else "", "questions": qs,
            "islamic_keywords": en_kw, "islamic_keywords_bn": bn_kw}


# ---------------------------------------------------------------- 2. Search

def _build_jobs(plan, enabled, per_source, lang):
    """Each job: (source key, sub-question it belongs to, search text, limit, language for the source)."""
    jobs = []
    islamic = msg(lang, "islamic")
    topic_q = plan["questions"][0]["question"]
    for key in enabled:
        src = sources.SOURCES.get(key)
        if not src or not sources.is_available(key):
            continue
        mode = src["mode"]
        if mode == "islamic":
            for kw in plan.get("islamic_keywords", []):
                jobs.append((key, islamic, kw, per_source, lang if key == "quran" else "en"))
            if lang == "bn" and key == "hadith":
                for kw in plan.get("islamic_keywords_bn", []):
                    jobs.append((key, islamic, kw, per_source, "bn"))
        elif mode == "topic":
            if not BANGLA.search(plan["topic_query"]):
                jobs.append((key, topic_q, plan["topic_query"], per_source, "en"))
            if lang == "bn" and key in ("wikipedia", "news") and plan.get("topic_query_bn"):
                jobs.append((key, topic_q, plan["topic_query_bn"], per_source, "bn"))
        elif mode in ("bd", "bd_bn"):
            use_bn = mode == "bd_bn" and lang == "bn"
            for q in plan["questions"][:3]:
                text = q.get("query_bn") if use_bn else q["query"]
                if text and (use_bn or not BANGLA.search(text)):
                    jobs.append((key, q["question"], text, max(3, per_source // 2), "bn" if use_bn else "en"))
        else:
            for q in plan["questions"]:
                if not BANGLA.search(q["query"]):
                    jobs.append((key, q["question"], q["query"], per_source, "en"))
                if lang == "bn" and key == "web" and q.get("query_bn"):
                    jobs.append((key, q["question"], q["query_bn"], per_source, "bn"))
    return jobs


def _run_jobs(jobs, lang, log):
    raw, errors, counts = [], {}, {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(sources.SOURCES[k]["fn"], q, lim, lang=l): (k, question)
                   for k, question, q, lim, l in jobs}
        for f in as_completed(futures):
            key, question = futures[f]
            try:
                res = f.result()
            except Exception as e:
                errors[key] = str(e)[:150]
                continue
            counts[key] = counts.get(key, 0) + len(res)
            for it in res:
                it["question"] = question
                raw.append(it)
    for k in sorted(counts, key=counts.get, reverse=True):
        log(f"  {sources.SOURCES[k]['label']}: {counts[k]}{msg(lang, 'results')}")
    for k, e in errors.items():
        log(f"  ! {sources.SOURCES[k]['label']} {msg(lang, 'errors')}: {e}")
    return raw


# ---------------------------------------------------------------- 3. Merge and rank

def _norm_title(t):
    return re.sub(r"[^a-z0-9ঀ-৿]", "", (t or "").lower())[:90]


def dedupe(items):
    merged, index = [], {}
    rank = {"high": 2, "medium": 1, "low": 0}
    for it in items:
        keys = [k for k in (it.get("doi"), _norm_title(it["title"]), it.get("url")) if k and len(k) > 8]
        cur = next((index[k] for k in keys if k in index), None)
        if cur is None:
            it.setdefault("found_in", [it["source"]])
            merged.append(it)
            for k in keys:
                index[k] = it
            continue
        for k in keys:
            index.setdefault(k, cur)
        for s in it.get("found_in") or [it["source"]]:
            if s not in cur["found_in"]:
                cur["found_in"].append(s)
        if len(it.get("abstract") or "") > len(cur.get("abstract") or ""):
            cur["abstract"] = it["abstract"]
        cur["citations"] = max(cur.get("citations") or 0, it.get("citations") or 0) or None
        for k in ("year", "venue", "doi", "url", "pdf_url", "publisher", "via"):
            cur[k] = cur.get(k) or it.get(k)
        cur["retracted"] = cur.get("retracted") or it.get("retracted")
        cur["preprint"] = cur.get("preprint") and it.get("preprint")  # a published copy wins
        if not cur["authors"] and it["authors"]:
            cur["authors"] = it["authors"]
        if rank.get(it["tier"], 0) > rank.get(cur["tier"], 0):
            # Prefer the published (journal) record's metadata over a preprint or web copy.
            for k in ("title", "authors", "year", "venue", "doi", "type", "tier"):
                if it.get(k):
                    cur[k] = it[k]
    return merged


def score(items, plan):
    base = _tokens(plan["questions"][0]["question"]) | _tokens(plan.get("topic_query")) | _tokens(plan.get("topic_query_bn"))
    queries = {q["question"]: _tokens(q["query"]) | _tokens(q.get("query_bn")) | _tokens(q["question"])
               for q in plan["questions"]}
    for it in items:
        qt = queries.get(it.get("question"), set()) | base
        n = max(len(qt), 1)
        rel = 2 * len(qt & _tokens(it["title"])) / n + len(qt & _tokens(it.get("abstract"))) / n
        cit = 0.3 * math.log10((it.get("citations") or 0) + 1)
        tier = {"high": 0.5, "medium": 0.25, "low": 0.0}.get(it["tier"], 0)
        text = 0.3 if len(it.get("abstract") or "") > 150 else 0
        multi = 0.2 * (len(it.get("found_in", [])) - 1)
        it["score"] = round(rel + cit + tier + text + multi, 3)


# ---------------------------------------------------------------- 4. Citation trail

def follow_trail(items, cfg, lang, log):
    seeds = [it for it in items if it["type"] == "paper" and it.get("doi")][:cfg["seeds"]]
    if not seeds:
        return []
    log(msg(lang, "trail", n=len(seeds)))
    found = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(sources.citation_trail, s["doi"], cfg["per_seed"]): s for s in seeds}
        for f in as_completed(futures):
            seed = futures[f]
            try:
                res = f.result()
            except Exception as e:
                log(f"  ! {seed['title'][:60]}: {str(e)[:100]}")
                continue
            label = citations.in_text(seed)
            for it, kind in res:
                it["question"] = seed["question"]
                it["via"] = msg(lang, "via_ref" if kind == "reference" else "via_cite", s=label)
                it["found_in"] = ["citation_trail"]
                found.append(it)
    log(msg(lang, "trail_done", n=len(found)))
    return found


# ---------------------------------------------------------------- 5-6. Read full text and extract evidence

def _apply(it, r):
    try:
        it["relevance"] = max(0, min(5, int(r.get("relevance") or 0)))
    except (TypeError, ValueError):
        it["relevance"] = None
    it["findings"] = _list(r.get("findings"))
    it["data_points"] = _list(r.get("data_points"))
    for k in ("method", "sample", "limitations"):
        it[k] = _s(r.get(k))
    it["future"] = _s(r.get("future_research"))
    mt = _s(r.get("method_type")).lower()
    it["method_type"] = mt if mt in gapfinder.METHOD_TYPES else ""
    it["country"] = _s(r.get("country"))
    q = _s(r.get("quote"))
    source_text = (it.get("_fulltext") or "") + " " + (it.get("abstract") or "")
    it["quote"] = q if q and q[:40].lower() in re.sub(r"\s+", " ", source_text).lower() else ""
    it["score"] += 0.4 * (it["relevance"] or 0)


def read_full_texts(items, cfg, topic, lang, log):
    candidates = [it for it in items if it["type"] == "paper" and "retracted" not in it.get("flags", [])
                  and (fulltext.pdf_candidates(it) or (it.get("doi") and config.CONTACT_EMAIL))][:cfg["fulltext"] * 2]
    if not candidates:
        return
    log(msg(lang, "fulltext", n=len(candidates)))
    got = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(fulltext.fetch, it): it for it in candidates}
        for f in as_completed(futures):
            it = futures[f]
            try:
                text, url = f.result()
            except Exception:
                continue
            if text:
                it["_fulltext"], it["pdf_url"] = text, url
                got.append(it)
    got = sorted(got, key=lambda x: x["score"], reverse=True)[:cfg["fulltext"]]
    log(msg(lang, "fulltext_got", n=len(got)))
    if not llm.enabled():
        return
    for i, it in enumerate(got, 1):
        log(msg(lang, "fulltext_reading", i=i, n=len(got), t=it["title"][:70]))
        try:
            r = llm.json_call(FULLTEXT_PROMPT.format(topic=topic, question=it["question"], title=it["title"],
                                                     year=it.get("year") or "n.d.", text=it["_fulltext"],
                                                     method_types=METHOD_LIST,
                                                     lang_rule=LANG_RULES["extract"][lang]))
        except Exception as e:
            log(msg(lang, "skipped", i=i, e=str(e)[:120]))
            continue
        _apply(it, r)
        it["fulltext"] = True
        it["score"] += 0.5


def extract(items, topic, lang, log, batch_size=8):
    todo = [it for it in items if len(it.get("abstract") or "") > 80 and not it.get("fulltext")]
    batches = [todo[i:i + batch_size] for i in range(0, len(todo), batch_size)]
    for bi, batch in enumerate(batches, 1):
        log(msg(lang, "reading", i=bi, n=len(batches)))
        text = "\n\n".join(
            f"[id={i}] Sub-question: {it['question']}\nTitle: {it['title']}\nYear: {it.get('year') or 'n.d.'}\n"
            f"Text: {it['abstract'][:1800]}" for i, it in enumerate(batch))
        try:
            res = llm.json_call(EXTRACT_PROMPT.format(topic=topic, sources=text, lang_rule=LANG_RULES["extract"][lang],
                                                      method_types=METHOD_LIST))
        except Exception as e:
            log(msg(lang, "skipped", i=bi, e=str(e)[:120]))
            continue
        by_id = {str(r.get("id")): r for r in res.get("items", []) if isinstance(r, dict)}
        for i, it in enumerate(batch):
            if str(i) in by_id:
                _apply(it, by_id[str(i)])


# ---------------------------------------------------------------- 7. Agreement / contradiction synthesis

def consensus_label(n_support, n_contra):
    if n_contra and n_contra >= n_support:
        return "contested"
    if n_contra:
        return "mixed"
    if n_support >= 3:
        return "strong"
    if n_support == 2:
        return "moderate"
    return "single"


def synthesize(items, plan, lang, log):
    groups = {}
    for it in items:
        if it.get("relevance") is not None and it["relevance"] >= 2 and it.get("findings") \
                and "retracted" not in it.get("flags", []):
            groups.setdefault(it["question"], []).append(it)
    order = [q["question"] for q in plan["questions"]] + [q for q in groups if q not in {x["question"] for x in plan["questions"]}]
    out = []
    todo = [q for q in order if len(groups.get(q, [])) >= 2]
    if todo:
        log(msg(lang, "synth", n=len(todo)))
    for q in todo:
        group = sorted(groups[q], key=lambda x: x["score"], reverse=True)[:25]
        cards = "\n".join(f"[{i}] {it['in_text']}: " + " | ".join(it["findings"][:4] + it["data_points"][:2])
                          for i, it in enumerate(group))
        try:
            res = llm.json_call(SYNTH_PROMPT.format(question=q, cards=cards, lang_rule=LANG_RULES["synth"][lang]))
        except Exception as e:
            log(msg(lang, "skipped", i=q[:40], e=str(e)[:100]))
            continue

        def pick(ids):
            picked = []
            for i in ids or []:
                try:
                    it = group[int(i)]
                except (ValueError, TypeError, IndexError):
                    continue
                if it not in picked:
                    picked.append(it)
            return picked

        claims = []
        for c in res.get("claims", []):
            if not isinstance(c, dict) or not _s(c.get("claim")):
                continue
            sup, con = pick(c.get("support")), pick(c.get("contradict"))
            con = [x for x in con if x not in sup]
            if not sup and not con:
                continue
            claims.append({"claim": _s(c["claim"]), "support": sup, "contradict": con, "note": _s(c.get("note")),
                           "consensus": consensus_label(len(sup), len(con))})
        if claims:
            out.append({"question": q, "claims": claims})
    return out


def _synthesis_to_json(synth):
    return [{"question": s["question"], "claims": [
        {**{k: c[k] for k in ("claim", "note", "consensus")},
         "support": [x["id"] for x in c["support"]], "contradict": [x["id"] for x in c["contradict"]]}
        for c in s["claims"]]} for s in synth]


# ---------------------------------------------------------------- Run

def run_research(run_id):
    run = db.get_run(run_id)
    topic, depth = run["topic"], run["depth"]
    lang = run.get("lang") or "en"
    opts = json.loads(run.get("options") or "{}")
    cfg = config.DEPTHS[depth]

    def log(m):
        db.append_log(run_id, m)

    try:
        db.update_run(run_id, status="planning")
        log(msg(lang, "planning", ai=llm.label()))
        plan = make_plan(topic, depth, lang, log)
        db.update_run(run_id, plan=json.dumps(plan, ensure_ascii=False))
        for q in plan["questions"]:
            extra = f" / {q['query_bn']}" if lang == "bn" and q.get("query_bn") else ""
            log(f"  • {q['question']}  [{q['query']}{extra}]")
        kws = plan.get("islamic_keywords", []) + (plan.get("islamic_keywords_bn", []) if lang == "bn" else [])
        if kws:
            log(f"  • {msg(lang, 'islamic_kw')}: {', '.join(kws)}")

        db.update_run(run_id, status="searching")
        jobs = _build_jobs(plan, json.loads(run["sources"]), cfg["per_source"], lang)
        log(msg(lang, "running", n=len(jobs), s=len({j[0] for j in jobs})))
        raw = _run_jobs(jobs, lang, log)
        items = dedupe(raw)
        log(msg(lang, "collected", r=len(raw), u=len(items)))
        score(items, plan)
        items.sort(key=lambda x: x["score"], reverse=True)

        if opts.get("trail", True) and items:
            db.update_run(run_id, status="trail")
            trail = follow_trail(items, cfg, lang, log)
            if trail:
                score(trail, plan)
                for it in trail:
                    it["score"] -= 0.2  # a trail paper must earn its place on relevance
                items = dedupe(items + trail)
                items.sort(key=lambda x: x["score"], reverse=True)

        db.update_run(run_id, status="quality")
        n_checked = quality.check(items, cfg["extract"], log)
        flagged = {f: sum(f in it["flags"] for it in items) for f in ("retracted", "preprint", "check_journal")}
        log(msg(lang, "quality_done", c=n_checked, **flagged))
        items.sort(key=lambda x: x["score"], reverse=True)

        if opts.get("fulltext", True) and items:
            db.update_run(run_id, status="fulltext")
            read_full_texts(items, cfg, topic, lang, log)

        if llm.enabled() and items:
            db.update_run(run_id, status="extracting")
            extract(items[:cfg["extract"]], topic, lang, log)
        items.sort(key=lambda x: x["score"], reverse=True)
        for it in items:
            if not it.get("findings"):
                it["findings"] = _first_sentences(it.get("abstract"))
            it["citation"] = citations.harvard(it)
            it["in_text"] = citations.in_text(it)

        synth = []
        if opts.get("synthesis", True) and llm.enabled():
            db.update_run(run_id, status="synthesis")
            synth = synthesize(items, plan, lang, log)

        db.insert_items(run_id, items)
        synth_json = _synthesis_to_json(synth)
        db.update_run(run_id, synthesis=json.dumps(synth_json, ensure_ascii=False))
        n_claims = sum(len(s["claims"]) for s in synth)
        n_gaps = 0
        if opts.get("gaps", True) and items:
            db.update_run(run_id, status="gaps")
            log(msg(lang, "gaps_log", n=len(items)))
            result = gapfinder.find_gaps(run, items, plan, synth_json, lang, log)
            db.update_run(run_id, gaps=json.dumps(result, ensure_ascii=False))
            n_gaps = len(result["gaps"])
            log(msg(lang, "gaps_done", n=n_gaps))
        db.update_run(run_id, status="done")
        extra = [msg(lang, "claims", n=n_claims)] if n_claims else []
        extra += [msg(lang, "gaps_done", n=n_gaps)] if n_gaps else []
        log(msg(lang, "done", n=len(items)) + "".join(f" · {e}" for e in extra))
    except Exception as e:
        log(f"{msg(lang, 'error')}: {e}")
        db.update_run(run_id, status="error")


def rerun_gaps(run_id, selected_only=False):
    run = db.get_run(run_id)
    lang = run.get("lang") or "en"
    items = db.get_items(run_id, selected_only=selected_only)
    if not items:
        raise ValueError("আগে কিছু কার্ড নির্বাচন করুন।" if lang == "bn" else "Select at least one card first.")
    result = gapfinder.find_gaps(run, items, json.loads(run.get("plan") or "{}"),
                                 json.loads(run.get("synthesis") or "[]"), lang,
                                 scope="selected" if selected_only else "all")
    db.update_run(run_id, gaps=json.dumps(result, ensure_ascii=False))
    return result


# ---------------------------------------------------------------- Draft

def draft_report(run_id):
    run = db.get_run(run_id)
    lang = run.get("lang") or "en"
    items = db.get_items(run_id, selected_only=True)
    if not items:
        raise ValueError("আগে কিছু কার্ড নির্বাচন করুন।" if lang == "bn" else "Select at least one card first.")
    if not llm.enabled():
        raise ValueError("Drafting needs an AI model. Add a free GEMINI_API_KEY to .env (see README).")
    by_id = {it["id"]: it for it in items}
    cards = []
    for it in items:
        flags = ", ".join(f.upper() for f in it.get("flags") or [])
        head = f"CITE AS {it['in_text']} | {it['title']} | {citations.TYPE_LABELS.get(it['type'], it['type'])}, reliability {it['tier']}"
        lines = [head + (f" | {flags}" if flags else ""), f"Sub-question: {it['question']}"]
        for label, key in (("Method", "method"), ("Sample", "sample"), ("Limitations", "limitations")):
            if it.get(key):
                lines.append(f"- {label}: {it[key]}")
        lines += [f"- Finding: {f}" for f in it["findings"]]
        lines += [f"- Data: {d}" for d in it["data_points"]]
        if not it["findings"] and it.get("abstract"):
            lines.append(f"- Summary: {it['abstract'][:600]}")
        cards.append("\n".join(lines))
    consensus = []
    for s in json.loads(run.get("synthesis") or "[]"):
        for c in s["claims"]:
            sup = [by_id[i]["in_text"] for i in c["support"] if i in by_id]
            con = [by_id[i]["in_text"] for i in c["contradict"] if i in by_id]
            if sup or con:
                consensus.append(f"- [{c['consensus'].upper()}] {c['claim']} | supported by: {', '.join(sup) or '-'}"
                                 f" | contradicted by: {', '.join(con) or '-'}" + (f" | why: {c['note']}" if c.get("note") else ""))
    gap_lines = []
    for g in (json.loads(run.get("gaps") or "{}") or {}).get("gaps", []):
        ev = [by_id[i]["in_text"] for i in g.get("evidence", []) if i in by_id]
        gap_lines.append(f"- [{g['priority'].upper()} · {g['type']}] {g['title']}: {g['description']}"
                         + (f" | evidence: {', '.join(ev)}" if ev else "")
                         + (f" | research question: {g['research_question']}" if g.get("research_question") else ""))
    md = llm.text_call(DRAFT_PROMPT.format(topic=run["topic"], cards="\n\n".join(cards),
                                           consensus="\n".join(consensus) or "(none)",
                                           gaps="\n".join(gap_lines) or "(none)",
                                           lang_rule=LANG_RULES["draft"][lang]))
    refs = sorted({it["citation"] for it in items if "retracted" not in (it.get("flags") or [])}, key=str.lower)
    md = md.strip() + f"\n\n## {REF_HEADING[lang]}\n\n" + "\n\n".join(refs) + "\n"
    db.update_run(run_id, draft=md)
    return md
