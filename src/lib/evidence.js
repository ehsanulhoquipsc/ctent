'use strict';
// Evidence helpers shared by the agent, the review page and the exports:
// Harvard citations, quality flags, open-access full text, method/country classification and the research gaps finder.
// Ported from the standalone CTENT Research Agent (citations.py, quality.py, fulltext.py, gaps.py).
const research = require('./research');
const I18N = require('./evidence-i18n.json');

// ---------------------------------------------------------------- Language helpers
const BANGLA = /[ঀ-৿]/;
function msg(lang, key, kw) {
  const s = (I18N.agent[lang] || I18N.agent.en)[key] || I18N.agent.en[key] || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (kw && kw[k] !== undefined ? kw[k] : ''));
}
const flagLabel = (lang, f) => ((I18N.flags[lang] || I18N.flags.en)[f] || f);
const consensusLabel = (lang, c) => ((I18N.consensus[lang] || I18N.consensus.en)[c] || c);
const priorityLabel = (lang, p) => ((I18N.priorities[lang] || I18N.priorities.en)[p] || p);
const tierLabel = (lang, t) => ((I18N.tiers[lang] || I18N.tiers.en)[t] || t);
const gapTypeLabel = (lang, t) => ((I18N.gaptypes[lang] || I18N.gaptypes.en)[t] || t);
const methodLabel = (lang, m) => msg(lang, 'mt_' + String(m).replace(' / ', '_').replace(/ /g, '_').replace(/-/g, '_'));
const TYPE_LABELS = { paper: 'Journal / paper', book: 'Book', report: 'Report', reference: 'Reference', religious: 'Primary religious text', web: 'Web page', news: 'News' };
const typeLabel = (lang, t) => (lang === 'bn' && I18N.types.bn[t]) || TYPE_LABELS[t] || t;

// ---------------------------------------------------------------- Harvard citations
function parseName(name) {
  name = String(name || '').trim();
  if (!name) return ['', ''];
  let last; let first;
  if (name.includes(',')) [last, first] = name.split(/,(.*)/s).map((p) => (p || '').trim());
  else {
    const parts = name.split(/\s+/);
    if (parts.length === 1 || /^(world bank|wikipedia)/i.test(name)) return [name, ''];
    last = parts.pop(); first = parts.join(' ');
  }
  const initials = String(first || '').split(/[\s\-.]+/).filter(Boolean).map((p) => p[0].toUpperCase() + '.').join('');
  return [last, initials];
}
function authorsStr(authors) {
  const names = (authors || []).map(parseName).filter(([l]) => l).map(([l, i]) => (i ? l + ', ' + i : l));
  if (!names.length) return '';
  if (names.length > 3) return names[0] + ' et al.';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
function inText(it) {
  const sur = (it.authors || []).map((a) => parseName(a)[0]).filter(Boolean);
  const year = it.year || 'n.d.';
  if (!sur.length) {
    const title = it.title || 'Untitled';
    if (it.source === 'quran') return "(Qur'an " + (title.split(/\s+/)[1] || '') + ')';
    const short = title.length <= 40 ? title : title.slice(0, 37).trim() + '...';
    return '(' + short + ', ' + year + ')';
  }
  const who = sur.length === 1 ? sur[0] : sur.length === 2 ? sur[0] + ' and ' + sur[1] : sur[0] + ' et al.';
  return '(' + who + ', ' + year + ')';
}
function harvard(it, accessed) {
  accessed = accessed || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const au = authorsStr(it.authors);
  const year = it.year || 'n.d.';
  const title = it.title || 'Untitled';
  const venue = it.venue || '';
  const link = it.doi ? 'doi: ' + it.doi + '.' : it.url ? 'Available at: ' + it.url + ' (Accessed: ' + accessed + ').' : '';
  if (it.source === 'quran') return "The Qur'an (n.d.) " + title.split(' ').slice(1).join(' ') + '. Translated by Sahih International. Available at: ' + it.url + ' (Accessed: ' + accessed + ').';
  if (it.type === 'book') return ((au || title) + ' (' + year + ') ' + title + '.' + (venue ? ' ' + venue + '.' : '') + ' ' + (it.url && !au ? link : '')).trim();
  if (it.type === 'paper') return ((au || 'Anonymous') + ' (' + year + ") '" + title + "'," + (venue ? ' ' + venue + '.' : '') + ' ' + link).replace(',.', '.').trim();
  return ((au || venue || title) + ' (' + year + ') ' + title + '. ' + link).trim();
}

// ---------------------------------------------------------------- Quality flags
const PREPRINT_VENUES = ['arxiv', 'ssrn', 'biorxiv', 'medrxiv', 'research square', 'preprints.org', 'techrxiv', 'osf preprints', 'psyarxiv', 'socarxiv', 'authorea', 'zenodo', 'researchgate'];
const CHECK_PUBLISHERS = ['omics', 'scientific research publishing', 'scirp', 'world academy of science, engineering', 'waset', 'science publishing group', 'sciencepg', 'iiste', 'juniper publishers', 'austin publishing', 'lupine publishers', 'crimson publishers', 'longdom', 'imedpub', 'herald scholarly', 'medcrave', 'global journals inc', 'sciencedomain', 'journalijar', 'ijsr', 'academia publishing'];
const CHECK_RE = new RegExp('\\b(?:' + CHECK_PUBLISHERS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
const FLAG_PENALTY = { retracted: 10, check_journal: 0.6, preprint: 0.2 };
function flagsFor(it) {
  const f = [];
  if (it.retracted) f.push('retracted');
  const venue = String(it.venue || '').toLowerCase();
  if (it.type === 'paper' && (it.preprint || PREPRINT_VENUES.some((p) => venue.includes(p)))) f.push('preprint');
  if (CHECK_RE.test(venue) || CHECK_RE.test(it.publisher || '')) f.push('check_journal');
  return f;
}
// Looks up retraction status for the top papers with DOIs, then sets flags on every item.
async function qualityCheck(items, limit, alive) {
  let checked = 0;
  for (const it of items) {
    if (checked >= limit) break;
    if (it.type !== 'paper' || !it.doi || it.retracted) continue;
    checked++;
    try { const info = await research.crossrefLookup(it.doi); it.retracted = it.retracted || info.retracted; it.publisher = it.publisher || info.publisher; } catch (e) { /* skip */ }
    if (alive && !(await alive())) break;
  }
  for (const it of items) { it.flags = flagsFor(it); it.score = (it.score || 0) - it.flags.reduce((s, f) => s + (FLAG_PENALTY[f] || 0), 0); }
  return checked;
}

// ---------------------------------------------------------------- Open-access full text
const MAX_PDF = 15000000;
const SECTION_RE = /^[ \t]*(?:[IVX]+\.|\d+(?:\.\d+)*\.?)?[ \t]*(abstract|introduction|background|literature review|related work|materials and methods|methods?|methodology|research (?:design|methods?|methodology)|data and methods?|results and discussion|results?|findings|discussion|limitations?(?: and future (?:work|research))?|conclusions?(?: and (?:recommendations|implications|future work))?|references|bibliography)[ \t]*:?[ \t]*$/gim;
const GROUPS = { 'materials and methods': 'methods', method: 'methods', methods: 'methods', methodology: 'methods', 'research design': 'methods', 'research method': 'methods', 'research methods': 'methods', 'research methodology': 'methods', 'data and method': 'methods', 'data and methods': 'methods', results: 'results', result: 'results', findings: 'results', 'results and discussion': 'results', discussion: 'discussion' };
function groupOf(h) { h = h.toLowerCase().trim(); if (h.startsWith('limitation')) return 'limitations'; if (h.startsWith('conclusion')) return 'conclusion'; return GROUPS[h]; }
function pdfCandidates(it) {
  const urls = [];
  for (let u of [it.pdf_url, it.url]) {
    if (!u) continue;
    if (u.includes('arxiv.org/abs/')) u = u.replace('/abs/', '/pdf/');
    if (/\.pdf($|\?)/i.test(u) || u.includes('/pdf/') || u === it.pdf_url) urls.push(u);
  }
  return [...new Set(urls)];
}
function keySections(text, cap = 14000) {
  let heads = [...text.matchAll(SECTION_RE)].map((m) => [m.index, m[1]]);
  const refs = heads.filter(([p, h]) => /^(references|bibliography)$/i.test(h) && p > text.length * 0.4).map(([p]) => p);
  if (refs.length) { const cut = refs[refs.length - 1]; text = text.slice(0, cut); heads = heads.filter(([p]) => p < cut); }
  const found = heads.map(([p, h]) => [p, h, groupOf(h)]).filter((x) => x[2]);
  if (new Set(found.map((x) => x[2])).size < 2) return text.length > 13500 ? (text.slice(0, 9000) + '\n[...]\n' + text.slice(-4500)).slice(0, cap) : text.slice(0, cap);
  const parts = ['[OPENING]\n' + text.slice(0, 2500).trim()];
  const seen = new Set();
  const positions = heads.map(([p]) => p).concat([text.length]);
  for (const [pos, , g] of found) {
    if (seen.has(g)) continue;
    seen.add(g);
    const end = positions.find((p) => p > pos);
    parts.push('[' + g.toUpperCase() + ']\n' + text.slice(pos, end).slice(0, 2800).trim());
  }
  return parts.join('\n\n').slice(0, cap);
}
async function pdfText(buf) {
  const pdf = require('pdf-parse/lib/pdf-parse.js');
  const out = await pdf(buf, { max: 40 });
  return String(out.text || '').replace(/-\n(?=[a-z])/g, '').replace(/[ \t]+/g, ' ');
}
// Returns { text, url } for an open-access paper, or null.
async function fetchFullText(it) {
  const urls = pdfCandidates(it);
  if (it.doi) { try { const extra = await research.unpaywallPdf(it.doi); if (extra) urls.push(extra); } catch (e) { /* none */ } }
  for (const url of [...new Set(urls)]) {
    let buf;
    try { buf = await research.request('fulltext', url, { as: 'buffer', retries: 0, timeout: 40000, headers: { accept: 'application/pdf,*/*' } }); } catch (e) { continue; }
    if (!buf || buf.length > MAX_PDF || buf.slice(0, 5).toString() !== '%PDF-') continue;
    let text;
    try { text = await pdfText(buf); } catch (e) { continue; }
    if (text.length > 2500) return { text: keySections(text), url };
  }
  return null;
}

// ---------------------------------------------------------------- Methods and countries
const METHOD_TYPES = ['survey', 'experiment', 'case study', 'qualitative interviews', 'mixed methods', 'systematic review', 'meta-analysis', 'secondary data / econometric', 'theoretical / conceptual', 'other'];
const CORE_METHODS = ['survey', 'experiment', 'case study', 'qualitative interviews', 'mixed methods', 'systematic review', 'secondary data / econometric'];
const METHOD_RE = [
  ['meta-analysis', /meta-?analy/], ['systematic review', /systematic (literature )?review|scoping review|bibliometric|literature review/],
  ['mixed methods', /mixed[- ]methods?|multi-?method/], ['experiment', /\bexperiment|randomi[sz]ed|\brct\b|quasi-experiment|field trial/],
  ['case study', /case stud/], ['survey', /\bsurvey|questionnaire|respondents/],
  ['qualitative interviews', /interview|focus group|ethnograph|thematic analysis|grounded theory|qualitative/],
  ['secondary data / econometric', /panel data|regression|econometric|secondary data|time[- ]series|difference-in-differences|structural equation|\bsem\b|pls-sem/],
  ['theoretical / conceptual', /conceptual (paper|framework|model)|theoretical (paper|framework|model)|we propose a (framework|model)/]
];
const GAP_TYPES = ['empirical', 'methodological', 'contextual', 'temporal', 'theoretical', 'conflicting', 'practical', 'author'];
const PRIORITY = { high: 0, medium: 1, low: 2 };
const COUNTRIES = ('Afghanistan Albania Algeria Argentina Armenia Australia Austria Azerbaijan Bahrain Bangladesh Belarus Belgium Bhutan Bolivia Bosnia Botswana Brazil Brunei Bulgaria Cambodia Cameroon Canada Chile China Colombia Croatia Cuba Cyprus Czechia Denmark Ecuador Egypt Estonia Ethiopia Fiji Finland France Georgia Germany Ghana Greece Guatemala Hungary Iceland India Indonesia Iran Iraq Ireland Israel Italy Jamaica Japan Jordan Kazakhstan Kenya Kuwait Kyrgyzstan Laos Latvia Lebanon Libya Lithuania Luxembourg Madagascar Malawi Malaysia Maldives Malta Mauritius Mexico Moldova Mongolia Morocco Mozambique Myanmar Namibia Nepal Netherlands Nigeria Norway Oman Pakistan Palestine Panama Paraguay Peru Philippines Poland Portugal Qatar Romania Russia Rwanda Senegal Serbia Singapore Slovakia Slovenia Somalia Spain Sudan Sweden Switzerland Syria Taiwan Tajikistan Tanzania Thailand Tunisia Turkey Uganda Ukraine Uruguay Uzbekistan Venezuela Vietnam Yemen Zambia Zimbabwe').split(' ');
const MULTI = { 'south africa': 'South Africa', 'south korea': 'South Korea', korea: 'South Korea', 'new zealand': 'New Zealand', 'saudi arabia': 'Saudi Arabia', 'sri lanka': 'Sri Lanka', 'united arab emirates': 'United Arab Emirates', uae: 'United Arab Emirates', 'united kingdom': 'United Kingdom', uk: 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom', 'united states': 'United States', usa: 'United States', 'u.s.': 'United States', us: 'United States', america: 'United States', 'hong kong': 'Hong Kong', 'czech republic': 'Czechia', 'türkiye': 'Turkey', 'viet nam': 'Vietnam', 'costa rica': 'Costa Rica', 'ivory coast': "Côte d'Ivoire", 'dominican republic': 'Dominican Republic', 'papua new guinea': 'Papua New Guinea' };
const BN_COUNTRIES = { 'বাংলাদেশ': 'Bangladesh', 'ভারত': 'India', 'পাকিস্তান': 'Pakistan', 'চীন': 'China', 'নেপাল': 'Nepal', 'অস্ট্রেলিয়া': 'Australia', 'যুক্তরাষ্ট্র': 'United States', 'যুক্তরাজ্য': 'United Kingdom', 'মালয়েশিয়া': 'Malaysia', 'সৌদি আরব': 'Saudi Arabia', 'শ্রীলঙ্কা': 'Sri Lanka', 'ইন্দোনেশিয়া': 'Indonesia', 'জাপান': 'Japan', 'মিয়ানমার': 'Myanmar', 'তুরস্ক': 'Turkey', 'মিশর': 'Egypt', 'কানাডা': 'Canada' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COUNTRY_RE = new RegExp('\\b(' + COUNTRIES.map((c) => esc(c.toLowerCase())).concat(Object.keys(MULTI).map(esc)).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
const CASE = Object.fromEntries(COUNTRIES.map((c) => [c.toLowerCase(), c]));
const NOT_COUNTRY = new Set(['', 'n/a', 'na', 'none', 'not stated', 'unknown', 'not specified', 'unspecified', '-', 'various']);
function countriesIn(text) {
  const found = [];
  const low = String(text || '').toLowerCase();
  for (const m of low.matchAll(COUNTRY_RE)) {
    const w = m[1];
    if (w === 'us' && !/\bthe us\b|\bin us\b|\bus[- ]based\b/.test(low)) continue;
    const name = MULTI[w] || CASE[w];
    if (name && !found.includes(name)) found.push(name);
  }
  for (const [bn, name] of Object.entries(BN_COUNTRIES)) if (String(text || '').includes(bn) && !found.includes(name)) found.push(name);
  return found;
}
function normCountry(raw) {
  const out = [];
  for (const part of String(raw || '').split(/,|;|\/|\band\b|&/)) {
    const p = part.trim().replace(/^\.+|\.+$/g, '');
    if (NOT_COUNTRY.has(p.toLowerCase())) continue;
    const known = countriesIn(p);
    if (known.length) out.push(...known); else if (p.length < 40) out.push(p.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return [...new Set(out.filter(Boolean))];
}
function classifyMethod(it) {
  const mt = String(it.method_type || '').trim().toLowerCase();
  if (METHOD_TYPES.includes(mt)) return mt;
  const text = [it.method, it.title, it.abstract].join(' ').toLowerCase();
  for (const [name, re] of METHOD_RE) if (re.test(text)) return name;
  return '';
}
function itemCountries(it) {
  if (it.country) { const f = normCountry(it.country); if (f.length) return f; }
  return countriesIn([it.sample, it.title, it.abstract].join(' ')).slice(0, 3);
}

// ---------------------------------------------------------------- Research gaps
const scholarly = (it) => ['paper', 'report', 'book'].includes(it.type) && !(it.flags || []).includes('retracted');
const count = (arr) => { const m = new Map(); for (const k of arr) if (k) m.set(k, (m.get(k) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };

// Hard numbers about the collection. Everything here is counted, nothing is guessed.
function analyse(items, plan, synthesis, topicText, lang) {
  const nowY = new Date().getFullYear();
  const islamic = msg(lang, 'islamic');
  const relevant = items.filter((it) => !(it.flags || []).includes('retracted') && (it.relevance === null || it.relevance === undefined || it.relevance >= 2));
  const schol = relevant.filter(scholarly);
  const papers = schol.filter((it) => it.type === 'paper');
  const questions = (plan.questions || []).map((q) => q.question);
  for (const it of items) if (it.question && !questions.includes(it.question)) questions.push(it.question);
  const coverage = questions.filter((q) => q !== islamic).map((q) => {
    const g = relevant.filter((it) => it.question === q);
    return { question: q, n: g.length, high: g.filter((it) => it.tier === 'high').length, full: g.filter((it) => it.fulltext).length, data: g.filter((it) => (it.data_points || []).length).length };
  });
  const avg = coverage.length ? Math.round((coverage.reduce((s, c) => s + c.n, 0) / coverage.length) * 10) / 10 : 0;
  for (const c of coverage) c.thin = c.n < 3 || c.high === 0 || (avg >= 6 && c.n < avg * 0.35);
  const methods = count(papers.map(classifyMethod));
  const nMethod = methods.reduce((s, m) => s + m[1], 0);
  const countries = count(schol.flatMap(itemCountries));
  const withCountry = schol.filter((it) => itemCountries(it).length).length;
  const topicCountries = countriesIn([topicText, plan.topic_query, plan.topic_query_bn].join(' ')).map((c) => ({ country: c, n: (countries.find((x) => x[0] === c) || [0, 0])[1] }));
  const years = schol.map((it) => parseInt(it.year, 10)).filter((y) => y > 1900).sort((a, b) => a - b);
  const recentFrom = nowY - 2;
  const ids = new Set(items.map((it) => it.id));
  const contested = []; const single = [];
  for (const s of synthesis || []) for (const c of s.claims || []) {
    const e = { question: s.question, claim: c.claim, consensus: c.consensus, support: (c.support || []).filter((i) => ids.has(i)), contradict: (c.contradict || []).filter((i) => ids.has(i)), note: c.note || '' };
    if (['contested', 'mixed'].includes(c.consensus)) contested.push(e); else if (c.consensus === 'single') single.push(e);
  }
  const stated = schol.filter((it) => it.id && (it.limitations || it.future)).map((it) => ({ id: it.id, cite: it.in_text || '', limitations: it.limitations || '', future: it.future || '' }));
  return {
    n_items: items.length, n_relevant: relevant.length, n_scholarly: schol.length, n_papers: papers.length, coverage, coverage_avg: avg,
    methods, n_method: nMethod, missing_methods: CORE_METHODS.filter((m) => !methods.some((x) => x[0] === m)),
    countries: countries.slice(0, 15), n_country: withCountry, topic_countries: topicCountries,
    years: { n: years.length, median: years.length ? years[Math.floor(years.length / 2)] : null, oldest: years[0] || null, newest: years[years.length - 1] || null, recent_from: recentFrom, recent: years.filter((y) => y >= recentFrom).length, by_year: count(years.map(String)).sort((a, b) => a[0] - b[0]) },
    contested, single: single.slice(0, 10), stated
  };
}

const gap = (type, priority, title, description, signal, evidence) => ({ type, priority, title, description, signal, evidence: evidence || [], research_question: '', method: '' });
function ruleGaps(st, lang) {
  const L = (k, kw) => msg(lang, k, kw);
  const ml = (m) => methodLabel(lang, m);
  const out = [];
  for (const c of st.coverage) if (c.thin) out.push(gap('empirical', c.n <= 1 ? 'high' : 'medium', L('g_thin_t', { q: c.question }), L('g_thin_d', { n: c.n, h: c.high, avg: st.coverage_avg }), L('g_thin_s', { n: c.n, h: c.high })));
  if (st.n_method >= 6) {
    const [top, topN] = st.methods[0];
    const share = Math.round((100 * topN) / st.n_method);
    const missing = st.missing_methods.filter((m) => m !== top);
    if (missing.length || share >= 55) out.push(gap('methodological', 'medium', L('g_method_t'), L('g_method_d', { missing: missing.slice(0, 4).map(ml).join(', ') || '-', top: ml(top), share }), L('g_method_s', { top: ml(top), n: topN, total: st.n_method })));
  }
  if (st.n_country >= 5) {
    const [top, topN] = st.countries[0];
    for (const tc of st.topic_countries) if (tc.n < Math.max(3, 0.25 * st.n_country)) out.push(gap('contextual', 'high', L('g_ctx_t', { c: tc.country }), L('g_ctx_d', { c: tc.country, n: tc.n, total: st.n_country, top }), L('g_ctx_s', { c: tc.country, n: tc.n, total: st.n_country })));
    const share = Math.round((100 * topN) / st.n_country);
    if (!st.topic_countries.length && share >= 40) out.push(gap('contextual', 'medium', L('g_conc_t'), L('g_conc_d', { share, top }), L('g_conc_s', { top, n: topN, total: st.n_country })));
  }
  const y = st.years;
  if (y.n >= 8) {
    const share = Math.round((100 * y.recent) / y.n);
    if (share < 20) out.push(gap('temporal', share < 10 ? 'medium' : 'low', L('g_time_t'), L('g_time_d', { r: y.recent, n: y.n, share, y: y.recent_from, med: y.median }), L('g_time_s', { r: y.recent, n: y.n, y: y.recent_from })));
  }
  for (const c of st.contested.slice(0, 4)) out.push(gap('conflicting', c.consensus === 'contested' ? 'high' : 'medium', L('g_conf_t', { claim: c.claim.slice(0, 110) }), L('g_conf_d', { s: c.support.length, c: c.contradict.length }) + (c.note ? ' ' + c.note : ''), L('g_conf_s', { s: c.support.length, c: c.contradict.length }), c.support.concat(c.contradict)));
  if (st.stated.length >= 2) {
    const ex = st.stated.slice(0, 3).map((s) => s.cite + ' ' + (s.limitations || s.future).slice(0, 120)).join('; ');
    out.push(gap('author', 'low', L('g_lim_t'), L('g_lim_d', { n: st.stated.length, ex }), L('g_lim_s', { n: st.stated.length }), st.stated.slice(0, 8).map((s) => s.id)));
  }
  return out;
}

const GAPS_PROMPT = `You are an experienced academic supervisor helping a researcher find RESEARCH GAPS.
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
{"gaps": [{"title": "...", "type": "...", "priority": "...", "description": "2-3 sentences: what is missing and why it matters",
  "signal": "...", "evidence": [ids], "research_question": "...", "method": "..."}]}

ANALYSIS:
{analysis}`;
const GAP_LANG = { en: 'Write in English.', bn: 'Write title, description, signal, research_question and method in formal Bangla (প্রমিত বাংলা). Keep the type and priority values in English.' };
const fill = (tpl, kw) => tpl.replace(/\{(\w+)\}/g, (m, k) => (kw[k] !== undefined ? kw[k] : m));

function analysisText(st, items) {
  const refs = []; const local = new Map();
  const ref = (id) => { if (!local.has(id)) { local.set(id, refs.length); refs.push(id); } return local.get(id); };
  const lines = ['SUB-QUESTION COVERAGE (relevant sources / high reliability / read in full / with data):'];
  for (const c of st.coverage) lines.push('- ' + c.question + ': ' + c.n + ' / ' + c.high + ' / ' + c.full + ' / ' + c.data + (c.thin ? ' <- THIN' : ''));
  if (st.methods.length) lines.push('\nMETHODS (' + st.n_method + ' papers classified): ' + st.methods.map(([m, n]) => m + ' ' + n).join(', ') + (st.missing_methods.length ? '; not found: ' + st.missing_methods.join(', ') : '') + (st.n_method < 6 ? ' (small sample - treat with caution)' : ''));
  if (st.countries.length) lines.push('\nCOUNTRIES STUDIED (' + st.n_country + ' sources state one): ' + st.countries.map(([c, n]) => c + ' ' + n).join(', ') + (st.n_country < 5 ? ' (small sample - treat with caution)' : ''));
  if (st.topic_countries.length) lines.push('COUNTRIES NAMED IN THE TOPIC: ' + st.topic_countries.map((t) => t.country + ' (' + t.n + ' sources)').join(', '));
  const y = st.years;
  if (y.n) lines.push('\nYEARS: ' + y.n + ' dated sources, ' + y.oldest + '-' + y.newest + ', median ' + y.median + ', ' + y.recent + ' from ' + y.recent_from + ' or later');
  if (st.contested.length) { lines.push('\nCONTESTED OR MIXED CLAIMS:'); for (const c of st.contested.slice(0, 8)) lines.push('- [' + c.consensus + '] ' + c.claim + ' (support [' + c.support.map(ref) + '], contradict [' + c.contradict.map(ref) + '])' + (c.note ? ' - ' + c.note : '')); }
  if (st.single.length) { lines.push('\nCLAIMS RESTING ON A SINGLE SOURCE:'); for (const c of st.single.slice(0, 6)) lines.push('- ' + c.claim + ' [' + c.support.map(ref) + ']'); }
  if (st.stated.length) { lines.push('\nLIMITATIONS AND FUTURE RESEARCH STATED BY AUTHORS:'); for (const s of st.stated.slice(0, 25)) lines.push('[' + ref(s.id) + '] ' + s.cite + ' ' + [s.limitations ? 'limitations: ' + s.limitations : '', s.future ? 'future research: ' + s.future : ''].filter(Boolean).join('; ')); }
  const top = items.filter((it) => scholarly(it) && (it.findings || []).length && it.id && (it.relevance === null || it.relevance === undefined || it.relevance >= 3)).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 25);
  if (top.length) { lines.push('\nKEY FINDINGS (context):'); for (const it of top) { const extra = [it.method, it.sample].filter(Boolean).join(' | '); lines.push('[' + ref(it.id) + '] ' + (it.in_text || '') + ' ' + String(it.question || '').slice(0, 60) + ': ' + it.findings.slice(0, 2).join(' | ') + (extra ? ' (' + extra + ')' : '')); } }
  return { text: lines.join('\n'), refs };
}

async function findGaps({ topic, depth, items, plan, synthesis, lang, llm, log, scope }) {
  const st = analyse(items, plan || {}, synthesis || [], topic, lang);
  const k = { quick: '3-5', standard: '5-7', deep: '7-10' }[depth] || '5-7';
  let gaps = []; let ai = false;
  if (llm && llm.available() && st.n_relevant >= 3) {
    try {
      const { text, refs } = analysisText(st, items);
      const ids = new Set(items.map((it) => it.id));
      const res = await llm.json('Reply with JSON only.', fill(GAPS_PROMPT, { topic, n: st.n_relevant, k, analysis: text, lang_rule: GAP_LANG[lang] || GAP_LANG.en }));
      gaps = (res.gaps || []).filter((g) => g && String(g.title || '').trim()).map((g) => {
        const ev = [...new Set((g.evidence || []).map((i) => refs[parseInt(i, 10)]).filter((id) => id && ids.has(id)))];
        const type = String(g.type || '').toLowerCase().trim(); const pr = String(g.priority || '').toLowerCase().trim();
        return { type: GAP_TYPES.includes(type) ? type : 'empirical', priority: PRIORITY[pr] !== undefined ? pr : 'medium', title: String(g.title).trim().slice(0, 300), description: String(g.description || '').trim().slice(0, 1500), signal: String(g.signal || '').trim().slice(0, 600), evidence: ev, research_question: String(g.research_question || '').trim().slice(0, 600), method: String(g.method || '').trim().slice(0, 600) };
      });
      ai = gaps.length > 0;
    } catch (e) { if (log) await log(msg(lang, 'gaps_ai_failed', { e: String(e.message).slice(0, 120) })); }
  }
  if (!gaps.length) gaps = ruleGaps(st, lang);
  gaps.sort((a, b) => (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1));
  return { scope: scope || 'all', ai, stats: st, gaps, created: new Date().toISOString() };
}

module.exports = {
  BANGLA, msg, flagLabel, consensusLabel, priorityLabel, tierLabel, gapTypeLabel, methodLabel, typeLabel, TYPE_LABELS,
  inText, harvard, authorsStr, flagsFor, qualityCheck, pdfCandidates, keySections, fetchFullText,
  METHOD_TYPES, GAP_TYPES, classifyMethod, itemCountries, countriesIn, analyse, ruleGaps, findGaps, count
};
