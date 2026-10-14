"""Research gaps finder.

Step 1 (no AI): measures the collected literature - how well each sub-question is covered, which research
methods, countries and years the studies come from, which claims are contested, and what limitations and
future-research directions the authors themselves state.
Step 2 (AI, optional): turns those signals into concrete, evidence-backed research gaps, each with a
suggested research question and method. Without AI, rule-based gaps are produced from the counts alone.

Gaps describe THIS collection of sources, not the entire literature, and are labelled that way."""
import datetime
import re
from collections import Counter

import llm
from translations import a as msg

METHOD_TYPES = ["survey", "experiment", "case study", "qualitative interviews", "mixed methods",
                "systematic review", "meta-analysis", "secondary data / econometric", "theoretical / conceptual", "other"]
CORE_METHODS = ["survey", "experiment", "case study", "qualitative interviews", "mixed methods",
                "systematic review", "secondary data / econometric"]
_METHOD_RE = [  # order matters: the first match wins
    ("meta-analysis", r"meta-?analy"),
    ("systematic review", r"systematic (literature )?review|scoping review|bibliometric|literature review"),
    ("mixed methods", r"mixed[- ]methods?|multi-?method"),
    ("experiment", r"\bexperiment|randomi[sz]ed|\brct\b|quasi-experiment|field trial"),
    ("case study", r"case stud"),
    ("survey", r"\bsurvey|questionnaire|respondents"),
    ("qualitative interviews", r"interview|focus group|ethnograph|thematic analysis|grounded theory|qualitative"),
    ("secondary data / econometric", r"panel data|regression|econometric|secondary data|time[- ]series|"
                                     r"difference-in-differences|structural equation|\bsem\b|pls-sem"),
    ("theoretical / conceptual", r"conceptual (paper|framework|model)|theoretical (paper|framework|model)|"
                                 r"we propose a (framework|model)"),
]
GAP_TYPES = ["empirical", "methodological", "contextual", "temporal", "theoretical", "conflicting", "practical", "author"]
PRIORITY = {"high": 0, "medium": 1, "low": 2}

COUNTRIES = """Afghanistan Albania Algeria Argentina Armenia Australia Austria Azerbaijan Bahrain Bangladesh Belarus Belgium
Bhutan Bolivia Bosnia Botswana Brazil Brunei Bulgaria Cambodia Cameroon Canada Chile China Colombia Croatia Cuba Cyprus
Czechia Denmark Ecuador Egypt Estonia Ethiopia Fiji Finland France Georgia Germany Ghana Greece Guatemala Hungary Iceland
India Indonesia Iran Iraq Ireland Israel Italy Jamaica Japan Jordan Kazakhstan Kenya Kuwait Kyrgyzstan Laos Latvia
Lebanon Libya Lithuania Luxembourg Madagascar Malawi Malaysia Maldives Malta Mauritius Mexico Moldova Mongolia Morocco
Mozambique Myanmar Namibia Nepal Netherlands Nigeria Norway Oman Pakistan Palestine Panama Paraguay Peru Philippines
Poland Portugal Qatar Romania Russia Rwanda Senegal Serbia Singapore Slovakia Slovenia Somalia Spain Sudan Sweden
Switzerland Syria Taiwan Tajikistan Tanzania Thailand Tunisia Turkey Uganda Ukraine Uruguay Uzbekistan Venezuela
Vietnam Yemen Zambia Zimbabwe""".split()
MULTI_WORD = {"south africa": "South Africa", "south korea": "South Korea", "korea": "South Korea",
              "new zealand": "New Zealand", "saudi arabia": "Saudi Arabia", "sri lanka": "Sri Lanka",
              "united arab emirates": "United Arab Emirates", "uae": "United Arab Emirates",
              "united kingdom": "United Kingdom", "uk": "United Kingdom", "britain": "United Kingdom",
              "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom",
              "united states": "United States", "usa": "United States", "u.s.": "United States", "us": "United States",
              "america": "United States", "hong kong": "Hong Kong", "czech republic": "Czechia",
              "türkiye": "Turkey", "viet nam": "Vietnam", "costa rica": "Costa Rica", "ivory coast": "Côte d'Ivoire",
              "dominican republic": "Dominican Republic", "papua new guinea": "Papua New Guinea"}
BN_COUNTRIES = {"বাংলাদেশ": "Bangladesh", "ভারত": "India", "পাকিস্তান": "Pakistan", "চীন": "China", "নেপাল": "Nepal",
                "অস্ট্রেলিয়া": "Australia", "যুক্তরাষ্ট্র": "United States", "যুক্তরাজ্য": "United Kingdom",
                "মালয়েশিয়া": "Malaysia", "সৌদি আরব": "Saudi Arabia", "শ্রীলঙ্কা": "Sri Lanka", "ইন্দোনেশিয়া": "Indonesia",
                "জাপান": "Japan", "মিয়ানমার": "Myanmar", "তুরস্ক": "Turkey", "মিশর": "Egypt", "কানাডা": "Canada"}
_COUNTRY_RE = re.compile(r"\b(" + "|".join(sorted([re.escape(c.lower()) for c in COUNTRIES] +
                                                  [re.escape(k) for k in MULTI_WORD], key=len, reverse=True)) + r")\b")
_CASE = {c.lower(): c for c in COUNTRIES}
NOT_COUNTRY = {"", "n/a", "na", "none", "not stated", "unknown", "not specified", "unspecified", "-", "various"}


def countries_in(text):
    """Countries named in free text (English and common Bangla names)."""
    found = []
    low = (text or "").lower()
    for m in _COUNTRY_RE.finditer(low):
        word = m.group(1)
        if word == "us" and not re.search(r"\bthe us\b|\bin us\b|\bus[- ]based\b", low):
            continue  # "us" is usually the pronoun
        name = MULTI_WORD.get(word) or _CASE.get(word)
        if name and name not in found:
            found.append(name)
    for bn, name in BN_COUNTRIES.items():
        if bn in (text or "") and name not in found:
            found.append(name)
    return found


def _norm_country(raw):
    out = []
    for part in re.split(r",|;|/|\band\b|&", raw or ""):
        p = part.strip().strip(".")
        if p.lower() in NOT_COUNTRY:
            continue
        known = countries_in(p)
        out += known or [p.title() if len(p) < 40 else ""]
    return [c for c in dict.fromkeys(out) if c]


def classify_method(it):
    mt = (it.get("method_type") or "").strip().lower()
    if mt in METHOD_TYPES:
        return mt
    text = f"{it.get('method') or ''} {it.get('title') or ''} {it.get('abstract') or ''}".lower()
    for name, pattern in _METHOD_RE:
        if re.search(pattern, text):
            return name
    return ""


def item_countries(it):
    if it.get("country"):
        found = _norm_country(it["country"])
        if found:
            return found
    return countries_in(f"{it.get('sample') or ''} {it.get('title') or ''} {it.get('abstract') or ''}")[:3]


def _scholarly(it):
    return it.get("type") in ("paper", "report", "book") and "retracted" not in (it.get("flags") or [])


def analyse(items, plan, synthesis, topic, lang):
    """Hard numbers about the collection. Everything here is counted, nothing is guessed."""
    now = datetime.date.today().year
    islamic = msg(lang, "islamic")
    relevant = [it for it in items if "retracted" not in (it.get("flags") or [])
                and (it.get("relevance") is None or it["relevance"] >= 2)]
    scholarly = [it for it in relevant if _scholarly(it)]
    papers = [it for it in scholarly if it["type"] == "paper"]

    questions = [q["question"] for q in plan.get("questions", [])]
    questions += [q for q in dict.fromkeys(it["question"] for it in items) if q not in questions]
    coverage = []
    for q in questions:
        if q == islamic:
            continue
        group = [it for it in relevant if it["question"] == q]
        coverage.append({"question": q, "n": len(group), "high": sum(it["tier"] == "high" for it in group),
                         "full": sum(bool(it.get("fulltext")) for it in group),
                         "data": sum(bool(it.get("data_points")) for it in group)})
    avg = round(sum(c["n"] for c in coverage) / len(coverage), 1) if coverage else 0
    for c in coverage:
        c["thin"] = c["n"] < 3 or c["high"] == 0 or (avg >= 6 and c["n"] < avg * 0.35)

    methods = Counter(m for m in (classify_method(it) for it in papers) if m)
    countries = Counter(c for it in scholarly for c in item_countries(it))
    with_country = sum(1 for it in scholarly if item_countries(it))
    topic_text = " ".join([topic, plan.get("topic_query") or "", plan.get("topic_query_bn") or ""])
    topic_countries = countries_in(topic_text)
    years = sorted(int(it["year"]) for it in scholarly if str(it.get("year") or "").isdigit() and int(it["year"]) > 1900)
    recent_from = now - 2

    by_id = {it["id"]: it for it in items if it.get("id") is not None}
    contested, single = [], []
    for s in synthesis or []:
        for c in s.get("claims", []):
            sup = [i for i in c.get("support", []) if i in by_id]
            con = [i for i in c.get("contradict", []) if i in by_id]
            entry = {"question": s["question"], "claim": c["claim"], "consensus": c.get("consensus"),
                     "support": sup, "contradict": con, "note": c.get("note") or ""}
            if c.get("consensus") in ("contested", "mixed"):
                contested.append(entry)
            elif c.get("consensus") == "single":
                single.append(entry)

    stated = [{"id": it["id"], "cite": it.get("in_text") or "", "limitations": it.get("limitations") or "",
               "future": it.get("future") or ""}
              for it in scholarly if it.get("id") is not None and (it.get("limitations") or it.get("future"))]
    return {
        "n_items": len(items), "n_relevant": len(relevant), "n_scholarly": len(scholarly), "n_papers": len(papers),
        "coverage": coverage, "coverage_avg": avg,
        "methods": methods.most_common(), "n_method": sum(methods.values()),
        "missing_methods": [m for m in CORE_METHODS if m not in methods],
        "countries": countries.most_common(15), "n_country": with_country, "topic_countries":
            [{"country": c, "n": countries.get(c, 0)} for c in topic_countries],
        "years": {"n": len(years), "median": years[len(years) // 2] if years else None,
                  "oldest": years[0] if years else None, "newest": years[-1] if years else None,
                  "recent_from": recent_from, "recent": sum(y >= recent_from for y in years),
                  "by_year": sorted(Counter(years).items())},
        "contested": contested, "single": single[:10], "stated": stated,
    }


# ---------------------------------------------------------------- Rule-based gaps (no AI needed)

def _gap(type_, priority, title, description, signal, evidence=None):
    return {"type": type_, "priority": priority, "title": title, "description": description, "signal": signal,
            "evidence": evidence or [], "research_question": "", "method": ""}


def rule_gaps(stats, lang):
    L = lambda k, **kw: msg(lang, k, **kw)  # noqa: E731
    mlabel = lambda m: L("mt_" + m.replace(" / ", "_").replace(" ", "_").replace("-", "_"))  # noqa: E731
    out = []
    for c in stats["coverage"]:
        if c["thin"]:
            out.append(_gap("empirical", "high" if c["n"] <= 1 else "medium", L("g_thin_t", q=c["question"]),
                            L("g_thin_d", n=c["n"], h=c["high"], avg=stats["coverage_avg"]),
                            L("g_thin_s", n=c["n"], h=c["high"])))
    if stats["n_method"] >= 6:
        top, top_n = stats["methods"][0]
        share = round(100 * top_n / stats["n_method"])
        missing = [m for m in stats["missing_methods"] if m != top]
        if missing or share >= 55:
            out.append(_gap("methodological", "medium", L("g_method_t"),
                            L("g_method_d", missing=", ".join(mlabel(m) for m in missing[:4]) or "-",
                              top=mlabel(top), share=share),
                            L("g_method_s", top=mlabel(top), n=top_n, total=stats["n_method"])))
    if stats["n_country"] >= 5:
        top, top_n = stats["countries"][0]
        for tc in stats["topic_countries"]:
            if tc["n"] < max(3, 0.25 * stats["n_country"]):
                out.append(_gap("contextual", "high", L("g_ctx_t", c=tc["country"]),
                                L("g_ctx_d", c=tc["country"], n=tc["n"], total=stats["n_country"], top=top),
                                L("g_ctx_s", c=tc["country"], n=tc["n"], total=stats["n_country"])))
        share = round(100 * top_n / stats["n_country"])
        if not stats["topic_countries"] and share >= 40:
            out.append(_gap("contextual", "medium", L("g_conc_t"), L("g_conc_d", share=share, top=top),
                            L("g_conc_s", top=top, n=top_n, total=stats["n_country"])))
    y = stats["years"]
    if y["n"] >= 8:
        share = round(100 * y["recent"] / y["n"])
        if share < 20:
            out.append(_gap("temporal", "medium" if share < 10 else "low", L("g_time_t"),
                            L("g_time_d", r=y["recent"], n=y["n"], share=share, y=y["recent_from"], med=y["median"]),
                            L("g_time_s", r=y["recent"], n=y["n"], y=y["recent_from"])))
    for c in stats["contested"][:4]:
        out.append(_gap("conflicting", "high" if c["consensus"] == "contested" else "medium",
                        L("g_conf_t", claim=c["claim"][:110]),
                        L("g_conf_d", s=len(c["support"]), c=len(c["contradict"])) + (f" {c['note']}" if c["note"] else ""),
                        L("g_conf_s", s=len(c["support"]), c=len(c["contradict"])), c["support"] + c["contradict"]))
    stated = stats["stated"]
    if len(stated) >= 2:
        examples = "; ".join(f"{s['cite']} {(s['limitations'] or s['future'])[:120]}" for s in stated[:3])
        out.append(_gap("author", "low", L("g_lim_t"), L("g_lim_d", n=len(stated), ex=examples),
                        L("g_lim_s", n=len(stated)), [s["id"] for s in stated[:8]]))
    return out


# ---------------------------------------------------------------- AI gaps

GAPS_PROMPT = """You are an experienced academic supervisor helping a student find RESEARCH GAPS.
Topic: "{topic}"

Below is an analysis of the {n} sources collected for this topic: how well each sub-question is covered,
which methods, countries and years the studies come from, contested claims, and the limitations and
future-research directions the authors themselves state (with source ids in [brackets]), plus key findings.

Identify {k} genuine, specific research gaps. Use these types:
- "empirical": a question or relationship with little or no evidence
- "methodological": missing research designs, weak methods, small or self-reported samples
- "contextual": countries, sectors, populations or settings that are under-studied
- "temporal": evidence that is old or missing recent developments
- "theoretical": missing or untested theory, frameworks or mechanisms
- "conflicting": findings that disagree and need resolving
- "practical": missing evidence for policy or practice

Rules:
- Base every gap on the analysis below. Quote the concrete signal (a count, a contested claim, an author's
  stated limitation) in "signal". Never invent numbers.
- The analysis covers only these collected sources, so write "few studies in this collection" rather than
  "no studies exist".
- "evidence": ids of sources whose findings or stated limitations show the gap (may be empty).
- "research_question": one concrete, researchable question that would fill the gap.
- "method": a suitable research design for that question (method, sample, context).
- "priority": "high", "medium" or "low", by how important and how clearly supported the gap is.
- Prefer gaps that matter for the topic over trivial ones. Do not repeat the same gap twice.
{lang_rule}
Return JSON only:
{{"gaps": [{{"title": "...", "type": "...", "priority": "...", "description": "2-3 sentences: what is missing and why it matters",
  "signal": "...", "evidence": [ids], "research_question": "...", "method": "..."}}]}}

ANALYSIS:
{analysis}"""

LANG_RULE = {"en": "Write in English.",
             "bn": "Write title, description, signal, research_question and method in formal Bangla (প্রমিত বাংলা). "
                   "Keep the type and priority values in English."}


def _analysis_text(stats, items, lang):
    L = lambda k, **kw: msg(lang, k, **kw)  # noqa: E731
    refs, local = [], {}

    def ref(iid):
        if iid not in local:
            local[iid] = len(local)
            refs.append(iid)
        return local[iid]

    by_id = {it["id"]: it for it in items if it.get("id") is not None}
    lines = ["SUB-QUESTION COVERAGE (relevant sources / high reliability / read in full / with data):"]
    lines += [f"- {c['question']}: {c['n']} / {c['high']} / {c['full']} / {c['data']}" + (" <- THIN" if c["thin"] else "")
              for c in stats["coverage"]]
    if stats["methods"]:
        lines.append(f"\nMETHODS ({stats['n_method']} papers classified): " +
                     ", ".join(f"{m} {n}" for m, n in stats["methods"]) +
                     (f"; not found: {', '.join(stats['missing_methods'])}" if stats["missing_methods"] else "") +
                     (" (small sample - treat with caution)" if stats["n_method"] < 6 else ""))
    if stats["countries"]:
        lines.append(f"\nCOUNTRIES STUDIED ({stats['n_country']} sources state one): " +
                     ", ".join(f"{c} {n}" for c, n in stats["countries"]) +
                     (" (small sample - treat with caution)" if stats["n_country"] < 5 else ""))
    if stats["topic_countries"]:
        lines.append("COUNTRIES NAMED IN THE TOPIC: " + ", ".join(f"{t['country']} ({t['n']} sources)" for t in stats["topic_countries"]))
    y = stats["years"]
    if y["n"]:
        lines.append(f"\nYEARS: {y['n']} dated sources, {y['oldest']}-{y['newest']}, median {y['median']}, "
                     f"{y['recent']} from {y['recent_from']} or later")
    if stats["contested"]:
        lines.append("\nCONTESTED OR MIXED CLAIMS:")
        for c in stats["contested"][:8]:
            lines.append(f"- [{c['consensus']}] {c['claim']} (support {[ref(i) for i in c['support']]}, "
                         f"contradict {[ref(i) for i in c['contradict']]})" + (f" - {c['note']}" if c["note"] else ""))
    if stats["single"]:
        lines.append("\nCLAIMS RESTING ON A SINGLE SOURCE:")
        lines += [f"- {c['claim']} {[ref(i) for i in c['support']]}" for c in stats["single"][:6]]
    if stats["stated"]:
        lines.append("\nLIMITATIONS AND FUTURE RESEARCH STATED BY AUTHORS:")
        for s in stats["stated"][:25]:
            parts = [f"limitations: {s['limitations']}" if s["limitations"] else "",
                     f"future research: {s['future']}" if s["future"] else ""]
            lines.append(f"[{ref(s['id'])}] {s['cite']} " + "; ".join(p for p in parts if p))
    top = sorted((it for it in items if _scholarly(it) and it.get("findings") and it.get("id") is not None
                  and (it.get("relevance") is None or it["relevance"] >= 3)), key=lambda x: x.get("score") or 0, reverse=True)[:25]
    if top:
        lines.append("\nKEY FINDINGS (context):")
        for it in top:
            extra = " | ".join(x for x in (it.get("method"), it.get("sample")) if x)
            lines.append(f"[{ref(it['id'])}] {it.get('in_text', '')} {it['question'][:60]}: " +
                         " | ".join(it["findings"][:2]) + (f" ({extra})" if extra else ""))
    return "\n".join(lines), refs, by_id


def ai_gaps(stats, items, topic, depth_k, lang):
    text, refs, by_id = _analysis_text(stats, items, lang)
    res = llm.json_call(GAPS_PROMPT.format(topic=topic, n=stats["n_relevant"], k=depth_k, analysis=text,
                                           lang_rule=LANG_RULE[lang]))
    out = []
    for g in res.get("gaps", []):
        if not isinstance(g, dict) or not str(g.get("title") or "").strip():
            continue
        ev = []
        for i in g.get("evidence") or []:
            try:
                iid = refs[int(i)]
            except (ValueError, TypeError, IndexError):
                continue
            if iid in by_id and iid not in ev:
                ev.append(iid)
        type_ = str(g.get("type") or "").lower().strip()
        prio = str(g.get("priority") or "").lower().strip()
        out.append({"type": type_ if type_ in GAP_TYPES else "empirical",
                    "priority": prio if prio in PRIORITY else "medium",
                    "title": str(g["title"]).strip(), "description": str(g.get("description") or "").strip(),
                    "signal": str(g.get("signal") or "").strip(), "evidence": ev,
                    "research_question": str(g.get("research_question") or "").strip(),
                    "method": str(g.get("method") or "").strip()})
    return out


def find_gaps(run, items, plan, synthesis, lang, log=None, scope="all"):
    stats = analyse(items, plan, synthesis, run["topic"], lang)
    k = {"quick": "4-6", "standard": "6-8", "deep": "8-12"}.get(run.get("depth"), "6-8")
    gaps, used_ai = [], False
    if llm.enabled() and stats["n_relevant"] >= 3:
        try:
            gaps, used_ai = ai_gaps(stats, items, run["topic"], k, lang), True
        except Exception as e:
            if log:
                log(msg(lang, "gaps_ai_failed", e=str(e)[:120]))
    if not gaps:
        gaps, used_ai = rule_gaps(stats, lang), False
    gaps.sort(key=lambda g: PRIORITY.get(g["priority"], 1))
    return {"scope": scope, "ai": used_ai, "stats": stats, "gaps": gaps,
            "created": datetime.datetime.now().strftime("%Y-%m-%d %H:%M")}
