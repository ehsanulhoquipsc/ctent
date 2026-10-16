'use strict';
// A research agent for one part of a topic:
//   1. plans a few searches from the part's brief
//   2. searches free sources (OpenAlex papers, Wikipedia)
//   3. keeps the most relevant sources and numbers them
//   4. asks the AI service for a summary and findings that cite ONLY those numbered sources
// Without an AI service it still collects real sources and lists their key sentences, marked low confidence.
const db = require('../db');
const llm = require('./llm');
const research = require('./research');
const evidence = require('./evidence');
const { notify, audit, topicLeaders } = require('./events');
const { now } = require('./util');

// How hard each depth works (per part). extract = cards read by AI from abstracts, fulltext = open-access PDFs read in full,
// seeds = top papers whose citation trail is followed, keep = most cards saved for review.
const DEPTH = {
  quick: { questions: 2, perSource: 5, extract: 16, fulltext: 2, seeds: 2, perSeed: 3, keep: 25, minutes: 10, label: 'Quick (~3 min)' },
  standard: { questions: 4, perSource: 8, extract: 32, fulltext: 5, seeds: 4, perSeed: 4, keep: 50, minutes: 20, label: 'Standard (~8 min)' },
  deep: { questions: 6, perSource: 12, extract: 60, fulltext: 10, seeds: 6, perSeed: 6, keep: 90, minutes: 35, label: 'Deep (~15–25 min)' }
};
const OPTIONS = { fulltext: 'Read the full text of open-access papers', trail: 'Follow the citation trail of the best papers', synthesis: 'Map where sources agree and contradict', gaps: 'Find research gaps and suggest research questions' };
const DEFAULT_OPTIONS = 'fulltext,trail,synthesis,gaps';
const CONCURRENCY = Math.max(1, parseInt(process.env.AGENT_CONCURRENCY || '2', 10));
const STOP = new Set(('a an and are as at be by can could do does for from has have how in into is it its of on or over should that the their this to under was what when where which who why will with within would next years year ' +
  'between these those were been than then there among using use based study role effect effects impact এবং ও এর কি কী কে যে এই সেই করে হয় হতে জন্য থেকে মধ্যে উপর একটি বা না').split(/\s+/));
const { BANGLA, msg } = evidence;

const queue = [];
let active = 0;
let testHook = null; // tests can await finished runs

async function log(runId, text) { await db('agent_logs').insert({ run_id: runId, text: String(text).slice(0, 500), created_at: now() }); }
async function step(part, progress, text) { await db('parts').where({ id: part.id }).update({ agent_progress: Math.min(99, Math.round(progress)), agent_step: String(text).slice(0, 240) }); }

function keywords(text, max) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9ঀ-৿\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, max || 8).join(' ');
}
const tokens = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9ঀ-৿]+/g)?.filter((w) => !STOP.has(w) && w.length > 2) || []);
function firstSentences(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?।]+[.!?।]+/g) || [String(text || '').slice(0, 240)];
  return s.slice(0, n || 1).join(' ').trim();
}
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
const fill = (tpl, kw) => tpl.replace(/\{(\w+)\}/g, (m, k) => (kw[k] !== undefined ? kw[k] : m));
// The researcher can stop a run, and the watchdog ends runs that hang; either way the job must not overwrite it.
async function alive(runId) { const r = await db('agent_runs').where({ id: runId }).select('status').first(); return !!r && r.status === 'running'; }
class Stopped extends Error {}

// ---------------------------------------------------------------- Prompts (from the standalone research agent)
const LANG_RULES = {
  plan: { en: 'Write each "question" in English.', bn: 'Write each "question" in clear, formal Bangla (প্রমিত বাংলা). Keep "query" in English.' },
  extract: { en: 'Write findings, data_points, method, sample and limitations in English.', bn: 'Write findings, data_points, method, sample and limitations in formal Bangla (প্রমিত বাংলা), even if the source is English. Keep numbers, names and dates exact; technical terms may stay in English in brackets. The quote must stay in the source\'s original language.' },
  synth: { en: 'Write claims and notes in English.', bn: 'Write claims and notes in formal Bangla (প্রমিত বাংলা).' },
  draft: { en: 'Write in British/Australian academic English.', bn: 'Write in formal academic Bangla (প্রমিত বাংলা). Technical terms may be followed by the English term in brackets.' }
};
const PLAN_PROMPT = `You are a senior research planner.
Overall research question: "{question}"
This agent's part of it: "{part}"
What the researcher wants this part to find out: "{brief}"{followup}

1. Break THIS PART into {n} focused sub-questions that together give deep, balanced coverage:
   background and definitions, theory, current evidence, statistics and data, debates and opposing views,
   real-world case studies, and gaps for future research.
2. For each sub-question write "query": a short ENGLISH keyword search (3-6 words) for academic databases,
   and "query_bn": a short BANGLA keyword search (2-5 words) for Bangla web and news search.
3. "topic_query": this part as a short English keyword search; "topic_query_bn": the same in Bangla.
4. If the part has a religious, ethical, social or Islamic angle, give up to 3 single ENGLISH keywords
   ("islamic_keywords", e.g. "justice") and the same in Bangla ("islamic_keywords_bn"). Otherwise empty lists.
{lang_rule}
Return JSON only:
{"topic_query": "...", "topic_query_bn": "...",
  "questions": [{"question": "...", "query": "...", "query_bn": "..."}],
  "islamic_keywords": ["..."], "islamic_keywords_bn": ["..."]}`;
const EXTRACT_PROMPT = `Research topic: "{topic}"
For each source below, judge how relevant it is to its sub-question and extract evidence from the given text ONLY.
Never invent facts, numbers or quotes that are not in the text. Leave a field empty if the text does not say.
{lang_rule}
Return JSON only:
{"items": [{"id": <id>, "relevance": <0-5>,
  "findings": ["1-3 key findings, paraphrased in your own words"],
  "data_points": ["every number/statistic with its context, e.g. '42% of SMEs adopted cloud tools by 2023'"],
  "method": "research design/method if stated (e.g. 'survey', 'case study', 'systematic review'), else empty",
  "sample": "sample size, population, country or context if stated, else empty",
  "limitations": "limitations if stated, else empty",
  "future_research": "future research the authors call for, if stated, else empty",
  "method_type": "one of: {method_types}, or empty",
  "country": "country or countries studied, in English, or empty",
  "quote": "one short exact phrase copied from the text (under 25 words), or empty"}]}

SOURCES:
{sources}`;
const FULLTEXT_PROMPT = `Research topic: "{topic}"
Sub-question this source was found for: "{question}"
Below are key sections of the FULL TEXT of: "{title}" ({year}).
Extract evidence from this text ONLY. Never invent facts, numbers or quotes. Leave a field empty if not stated.
{lang_rule}
Return JSON only:
{"relevance": <0-5>,
  "findings": ["3-5 specific key findings relevant to the topic, paraphrased"],
  "data_points": ["every important number/statistic with its context"],
  "method": "research design and method, e.g. 'mixed-methods: survey of SMEs + 12 interviews'",
  "sample": "sample size, population, country/context and period",
  "limitations": "limitations the authors state",
  "future_research": "future research directions the authors suggest, or empty",
  "method_type": "one of: {method_types}, or empty",
  "country": "country or countries studied, in English, or empty",
  "quote": "one short exact phrase copied from the text (under 25 words), or empty"}

TEXT:
{text}`;
const SYNTH_PROMPT = `Sub-question: "{question}"
Below are findings from different sources, each with an id. Identify the 3-8 most important CLAIMS these sources
make about the sub-question. For each claim, list the ids of sources that SUPPORT it and the ids of sources that
CONTRADICT or seriously qualify it. Only use what the findings say. If sources disagree, explain why in "note"
(different countries, methods, periods, samples...).
{lang_rule}
Return JSON only:
{"claims": [{"claim": "...", "support": [ids], "contradict": [ids], "note": "..."}]}

FINDINGS:
{cards}`;
const METHOD_LIST = evidence.METHOD_TYPES.map((m) => '"' + m + '"').join(', ');

// ---------------------------------------------------------------- 1. Plan
async function makePlan(topic, part, followup, depth, lang, runId) {
  const n = depth.questions;
  const topicText = part.title;
  if (llm.available()) {
    try {
      const p = await llm.json('Reply with JSON only.', fill(PLAN_PROMPT, {
        question: topic.question || topic.title, part: part.title, brief: part.description || part.title, n,
        followup: followup ? '\nThe researcher asked this agent to dig deeper: "' + followup + '"' : '', lang_rule: LANG_RULES.plan[lang]
      }), (name) => log(runId, msg(lang, 'planning', { ai: name })));
      const qs = (p.questions || []).filter((q) => q && q.question && q.query).slice(0, n).map((q) => ({ question: String(q.question).slice(0, 300), query: String(q.query).slice(0, 150), query_bn: String(q.query_bn || '').slice(0, 150) }));
      if (qs.length) {
        const tq = String(p.topic_query || keywords(part.title + ' ' + (part.description || ''), 6) || part.title).slice(0, 150);
        const tqBn = String(p.topic_query_bn || (BANGLA.test(topicText) ? topicText : '')).slice(0, 150);
        return { topic_query: tq, topic_query_bn: tqBn, questions: [{ question: part.title, query: tq, query_bn: tqBn }].concat(qs),
          islamic_keywords: list(p.islamic_keywords).slice(0, 3), islamic_keywords_bn: list(p.islamic_keywords_bn).slice(0, 3) };
      }
    } catch (e) { await log(runId, msg(lang, 'plan_failed', { e: String(e.message).slice(0, 150) })); }
  }
  if (BANGLA.test(part.title + (part.description || ''))) await log(runId, msg(lang, 'bn_no_ai'));
  const base = keywords((followup ? followup + ' ' : '') + part.title + ' ' + (part.description || ''), 6) || part.title;
  const angles = ['', 'systematic review', 'statistics data', 'challenges', 'case study', 'policy', 'future trends'];
  const qs = angles.slice(0, n + 1).map((a) => ({ question: a ? part.title + ' — ' + a : part.title, query: (base + ' ' + a).trim(), query_bn: BANGLA.test(part.title) ? part.title : '' }));
  const kw = [...tokens(part.title)].sort((a, b) => b.length - a.length).slice(0, 2);
  return { topic_query: base, topic_query_bn: BANGLA.test(part.title) ? part.title : '', questions: qs, islamic_keywords: kw.filter((k) => !BANGLA.test(k)), islamic_keywords_bn: kw.filter((k) => BANGLA.test(k)) };
}

// ---------------------------------------------------------------- 2. Search
function buildJobs(plan, enabled, perSource, lang) {
  const jobs = [];
  const islamic = msg(lang, 'islamic');
  const topicQ = plan.questions[0].question;
  for (const key of enabled) {
    const src = research.SOURCE_TYPES[key];
    if (!src || !research.available(key)) continue;
    if (src.mode === 'islamic') {
      for (const kw of plan.islamic_keywords || []) jobs.push([key, islamic, kw, perSource, key === 'quran' ? lang : 'en']);
      if (lang === 'bn' && key === 'hadith') for (const kw of plan.islamic_keywords_bn || []) jobs.push([key, islamic, kw, perSource, 'bn']);
    } else if (src.mode === 'topic') {
      if (!BANGLA.test(plan.topic_query)) jobs.push([key, topicQ, plan.topic_query, perSource, 'en']);
      if (lang === 'bn' && ['wikipedia', 'news'].includes(key) && plan.topic_query_bn) jobs.push([key, topicQ, plan.topic_query_bn, perSource, 'bn']);
    } else if (src.mode === 'bd' || src.mode === 'bd_bn') {
      const useBn = src.mode === 'bd_bn' && lang === 'bn';
      for (const q of plan.questions.slice(0, 3)) {
        const text = useBn ? q.query_bn : q.query;
        if (text && (useBn || !BANGLA.test(text))) jobs.push([key, q.question, text, Math.max(3, Math.floor(perSource / 2)), useBn ? 'bn' : 'en']);
      }
    } else {
      for (const q of plan.questions) {
        if (!BANGLA.test(q.query)) jobs.push([key, q.question, q.query, perSource, 'en']);
        if (lang === 'bn' && key === 'web' && q.query_bn) jobs.push([key, q.question, q.query_bn, perSource, 'bn']);
      }
    }
  }
  return jobs;
}
async function runJobs(jobs, since, part, runId, lang) {
  const raw = []; const errors = {}; const counts = {};
  let next = 0; let done = 0;
  const failures = {};
  async function worker() {
    while (next < jobs.length) {
      const [key, question, q, limit, l] = jobs[next++];
      if ((failures[key] || 0) >= 2) { done++; continue; } // this service is down or busy — don't keep hammering it
      try {
        const res = await research.SOURCE_TYPES[key].search(q, limit, { since, lang: l });
        counts[key] = (counts[key] || 0) + res.length;
        for (const it of res) { it.question = question; raw.push(it); }
      } catch (e) { failures[key] = (failures[key] || 0) + 1; errors[key] = String(e.message || e).slice(0, 150); }
      done++;
      await step(part, 12 + (done / jobs.length) * 33, 'Searching ' + research.label(key) + ': ' + q);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  if (!(await alive(runId))) throw new Stopped();
  for (const k of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) await log(runId, '  ' + research.label(k) + ': ' + counts[k] + msg(lang, 'results'));
  for (const [k, e] of Object.entries(errors)) await log(runId, '  ! ' + research.label(k) + ' ' + msg(lang, 'errors') + ': ' + e);
  return raw;
}

// ---------------------------------------------------------------- 3. Merge and rank
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9ঀ-৿]/g, '').slice(0, 90);
const TIER_RANK = { high: 2, medium: 1, low: 0 };
function dedupe(items) {
  const merged = []; const index = new Map();
  for (const it of items) {
    const keys = [it.doi, normTitle(it.title), it.url].filter((k) => k && k.length > 8);
    const cur = keys.map((k) => index.get(k)).find(Boolean);
    if (!cur) { it.found_in = it.found_in || [it.source]; merged.push(it); for (const k of keys) index.set(k, it); continue; }
    for (const k of keys) if (!index.has(k)) index.set(k, cur);
    for (const s of it.found_in || [it.source]) if (!cur.found_in.includes(s)) cur.found_in.push(s);
    if ((it.abstract || '').length > (cur.abstract || '').length) cur.abstract = it.abstract;
    cur.citations = Math.max(cur.citations || 0, it.citations || 0) || null;
    for (const k of ['year', 'venue', 'doi', 'url', 'pdf_url', 'publisher', 'via']) cur[k] = cur[k] || it[k];
    cur.retracted = cur.retracted || it.retracted;
    cur.preprint = cur.preprint && it.preprint; // a published copy wins
    if (!cur.authors.length && it.authors.length) cur.authors = it.authors;
    if ((TIER_RANK[it.tier] || 0) > (TIER_RANK[cur.tier] || 0)) for (const k of ['title', 'authors', 'year', 'venue', 'doi', 'type', 'tier']) if (it[k] && (!Array.isArray(it[k]) || it[k].length)) cur[k] = it[k];
  }
  return merged;
}
function score(items, plan) {
  const base = new Set([...tokens(plan.questions[0].question), ...tokens(plan.topic_query), ...tokens(plan.topic_query_bn)]);
  const qmap = new Map(plan.questions.map((q) => [q.question, new Set([...tokens(q.query), ...tokens(q.query_bn), ...tokens(q.question)])]));
  for (const it of items) {
    const qt = new Set([...(qmap.get(it.question) || []), ...base]);
    const n = Math.max(qt.size, 1);
    const inter = (set) => [...set].filter((w) => qt.has(w)).length;
    const rel = (2 * inter(tokens(it.title))) / n + inter(tokens(it.abstract)) / n;
    const cit = 0.3 * Math.log10((it.citations || 0) + 1);
    const tier = { high: 0.5, medium: 0.25, low: 0 }[it.tier] || 0;
    const text = (it.abstract || '').length > 150 ? 0.3 : 0;
    const multi = 0.2 * ((it.found_in || []).length - 1);
    it.score = Math.round((rel + cit + tier + text + multi) * 1000) / 1000;
  }
}
const byScore = (a, b) => (b.score || 0) - (a.score || 0);

// ---------------------------------------------------------------- 4. Citation trail
async function followTrail(items, depth, lang, runId) {
  const seeds = items.filter((it) => it.type === 'paper' && it.doi).slice(0, depth.seeds);
  if (!seeds.length) return [];
  await log(runId, msg(lang, 'trail', { n: seeds.length }));
  const found = [];
  for (const seed of seeds) {
    try {
      const res = await research.citationTrail(seed.doi, depth.perSeed);
      const lbl = evidence.inText(seed);
      for (const [it, kind] of res) { it.question = seed.question; it.via = msg(lang, kind === 'reference' ? 'via_ref' : 'via_cite', { s: lbl }); it.found_in = ['citation_trail']; found.push(it); }
    } catch (e) { await log(runId, '  ! ' + seed.title.slice(0, 60) + ': ' + String(e.message).slice(0, 100)); }
    if (!(await alive(runId))) throw new Stopped();
  }
  await log(runId, msg(lang, 'trail_done', { n: found.length }));
  return found;
}

// ---------------------------------------------------------------- 5-6. Read full text and extract evidence
function apply(it, r) {
  const rel = parseInt(r.relevance, 10);
  it.relevance = Number.isFinite(rel) ? Math.max(0, Math.min(5, rel)) : null;
  it.findings = list(r.findings).slice(0, 6);
  it.data_points = list(r.data_points).slice(0, 10);
  for (const k of ['method', 'sample', 'limitations']) it[k] = str(r[k]).slice(0, 1000);
  it.future = str(r.future_research).slice(0, 1000);
  const mt = str(r.method_type).toLowerCase();
  it.method_type = evidence.METHOD_TYPES.includes(mt) ? mt : '';
  it.country = str(r.country).slice(0, 200);
  const q = str(r.quote);
  const sourceText = ((it._fulltext || '') + ' ' + (it.abstract || '')).replace(/\s+/g, ' ').toLowerCase();
  it.quote = q && sourceText.includes(q.slice(0, 40).toLowerCase()) ? q.slice(0, 400) : ''; // only quotes that really are in the text
  it.score = (it.score || 0) + 0.4 * (it.relevance || 0);
}
async function readFullTexts(items, depth, topicText, lang, part, runId) {
  const cands = items.filter((it) => it.type === 'paper' && !(it.flags || []).includes('retracted') && (evidence.pdfCandidates(it).length || (it.doi && process.env.CONTACT_EMAIL))).slice(0, depth.fulltext * 2);
  if (!cands.length) return;
  await log(runId, msg(lang, 'fulltext', { n: cands.length }));
  const got = [];
  for (const it of cands) {
    if (got.length >= depth.fulltext) break;
    try { const r = await evidence.fetchFullText(it); if (r) { it._fulltext = r.text; it.pdf_url = r.url; got.push(it); } } catch (e) { /* skip */ }
    if (!(await alive(runId))) throw new Stopped();
  }
  await log(runId, msg(lang, 'fulltext_got', { n: got.length }));
  if (!llm.available()) return;
  let i = 0;
  for (const it of got.sort(byScore)) {
    i++;
    await step(part, 58 + (i / got.length) * 8, 'Reading full text ' + i + '/' + got.length);
    await log(runId, msg(lang, 'fulltext_reading', { i, n: got.length, t: it.title.slice(0, 70) }));
    try {
      apply(it, await llm.json('Reply with JSON only.', fill(FULLTEXT_PROMPT, { topic: topicText, question: it.question, title: it.title, year: it.year || 'n.d.', text: it._fulltext, method_types: METHOD_LIST, lang_rule: LANG_RULES.extract[lang] })));
      it.fulltext = true; it.score += 0.5;
    } catch (e) { await log(runId, msg(lang, 'skipped', { i, e: String(e.message).slice(0, 120) })); }
    if (!(await alive(runId))) throw new Stopped();
  }
}
async function extract(items, topicText, lang, part, runId, batchSize = 8) {
  const todo = items.filter((it) => (it.abstract || '').length > 80 && !it.fulltext);
  const batches = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let bi = 0;
  for (const batch of batches) {
    bi++;
    await step(part, 68 + (bi / batches.length) * 16, 'Reading sources: batch ' + bi + ' of ' + batches.length);
    await log(runId, msg(lang, 'reading', { i: bi, n: batches.length }));
    const text = batch.map((it, i) => '[id=' + i + '] Sub-question: ' + it.question + '\nTitle: ' + it.title + '\nYear: ' + (it.year || 'n.d.') + '\nText: ' + it.abstract.slice(0, 1800)).join('\n\n');
    try {
      const res = await llm.json('Reply with JSON only.', fill(EXTRACT_PROMPT, { topic: topicText, sources: text, lang_rule: LANG_RULES.extract[lang], method_types: METHOD_LIST }));
      const byId = new Map((res.items || []).filter((r) => r && typeof r === 'object').map((r) => [String(r.id), r]));
      batch.forEach((it, i) => { if (byId.has(String(i))) apply(it, byId.get(String(i))); });
    } catch (e) { await log(runId, msg(lang, 'skipped', { i: bi, e: String(e.message).slice(0, 120) })); }
    if (!(await alive(runId))) throw new Stopped();
  }
}

// ---------------------------------------------------------------- 7. Agreement / contradiction map
function consensusOf(nSup, nCon) {
  if (nCon && nCon >= nSup) return 'contested';
  if (nCon) return 'mixed';
  if (nSup >= 3) return 'strong';
  if (nSup === 2) return 'moderate';
  return 'single';
}
async function synthesize(items, plan, lang, runId) {
  const groups = new Map();
  for (const it of items) if (it.relevance !== null && it.relevance !== undefined && it.relevance >= 2 && (it.findings || []).length && !(it.flags || []).includes('retracted')) {
    if (!groups.has(it.question)) groups.set(it.question, []);
    groups.get(it.question).push(it);
  }
  const order = plan.questions.map((q) => q.question).concat([...groups.keys()].filter((q) => !plan.questions.some((x) => x.question === q)));
  const todo = order.filter((q) => (groups.get(q) || []).length >= 2);
  if (todo.length) await log(runId, msg(lang, 'synth', { n: todo.length }));
  const out = [];
  for (const q of todo) {
    const group = groups.get(q).sort(byScore).slice(0, 25);
    const cards = group.map((it, i) => '[' + i + '] ' + it.in_text + ': ' + it.findings.slice(0, 4).concat((it.data_points || []).slice(0, 2)).join(' | ')).join('\n');
    let res;
    try { res = await llm.json('Reply with JSON only.', fill(SYNTH_PROMPT, { question: q, cards, lang_rule: LANG_RULES.synth[lang] })); } catch (e) { await log(runId, msg(lang, 'skipped', { i: q.slice(0, 40), e: String(e.message).slice(0, 100) })); continue; }
    const pick = (ids) => [...new Set((ids || []).map((i) => group[parseInt(i, 10)]).filter(Boolean))];
    const claims = [];
    for (const c of res.claims || []) {
      if (!c || !str(c.claim)) continue;
      const sup = pick(c.support); const con = pick(c.contradict).filter((x) => !sup.includes(x));
      if (!sup.length && !con.length) continue;
      claims.push({ claim: str(c.claim).slice(0, 600), support: sup, contradict: con, note: str(c.note).slice(0, 600), consensus: consensusOf(sup.length, con.length) });
    }
    if (claims.length) out.push({ question: q, claims });
    if (!(await alive(runId))) throw new Stopped();
  }
  return out;
}

const J = (v) => JSON.stringify(v || []);
async function saveCards(runId, part, items) {
  const rows = [];
  let n = 0;
  for (const it of items) {
    n++;
    const row = {
      run_id: runId, n, kind: it.type, title: String(it.title).slice(0, 1000), authors: (it.authors || []).slice(0, 12).join('; ') || null, year: parseInt(it.year, 10) || null,
      venue: it.venue ? String(it.venue).slice(0, 300) : null, url: it.url || null, doi: it.doi ? it.doi.slice(0, 200) : null, cited_by: it.citations || 0, abstract: it.abstract ? it.abstract.slice(0, 6000) : null,
      question: it.question || null, source: it.source, found_in: J(it.found_in).slice(0, 400), type: it.type, tier: it.tier, findings: J(it.findings), data_points: J(it.data_points),
      method: it.method || null, sample: it.sample || null, limitations: it.limitations || null, future: it.future || null, method_type: it.method_type || null, country: it.country ? it.country.slice(0, 200) : null,
      quote: it.quote || null, flags: J(it.flags), fulltext: !!it.fulltext, via: it.via ? it.via.slice(0, 300) : null, pdf_url: it.pdf_url || null, publisher: it.publisher ? it.publisher.slice(0, 300) : null,
      relevance: it.relevance === undefined ? null : it.relevance, score: it.score || 0, selected: false, in_text: String(it.in_text).slice(0, 300), citation: it.citation
    };
    it.id = await db.insertId('agent_sources', row);
    rows.push(it);
  }
  // Each card also becomes one insertable finding for the paper; selecting the card keeps it.
  let pos = 0;
  for (const it of rows) {
    const text = (it.findings || []).join(' ').slice(0, 1500) || firstSentences(it.abstract, 2) || it.title;
    await db('agent_findings').insert({ run_id: runId, part_id: part.id, position: pos++, text, confidence: { high: 'High', medium: 'Medium', low: 'Low' }[it.tier] || 'Medium', cites: String(rows.indexOf(it) + 1), kept: false, source_id: it.id });
  }
}

async function execute(runId) {
  const run = await db('agent_runs').where({ id: runId }).first();
  if (!run || run.status !== 'running') return;
  const part = await db('parts').where({ id: run.part_id }).first();
  const topic = await db('topics').where({ id: run.topic_id }).first();
  if (!part || !topic) return;
  const depthKey = DEPTH[part.agent_depth] ? part.agent_depth : 'standard';
  const depth = DEPTH[depthKey];
  const lang = part.agent_lang === 'bn' ? 'bn' : 'en';
  const opts = new Set(String(part.agent_options === null || part.agent_options === undefined ? DEFAULT_OPTIONS : part.agent_options).split(',').filter(Boolean));
  const kinds = research.normalizeKeys(part.agent_sources || research.DEFAULT_SOURCES);
  const since = /^\d{4}$/.test(String(topic.agent_since || '')) ? topic.agent_since : null;
  const topicText = (topic.question || topic.title) + ' — ' + part.title;
  try {
    await db('parts').where({ id: part.id }).update({ agent_status: 'running' });
    await db('agent_runs').where({ id: runId }).update({ depth: depthKey, lang });
    await step(part, 5, 'Planning sub-questions');
    const plan = await makePlan(topic, part, run.followup, depth, lang, runId);
    if (!(await alive(runId))) throw new Stopped();
    await db('agent_runs').where({ id: runId }).update({ plan: JSON.stringify(plan) });
    for (const q of plan.questions) await log(runId, '  • ' + q.question + '  [' + q.query + (lang === 'bn' && q.query_bn ? ' / ' + q.query_bn : '') + ']');
    const kws = (plan.islamic_keywords || []).concat(lang === 'bn' ? plan.islamic_keywords_bn || [] : []);
    if (kws.length && kinds.some((k) => ['quran', 'hadith'].includes(k))) await log(runId, '  • ' + msg(lang, 'islamic_kw') + ': ' + kws.join(', '));

    const jobs = buildJobs(plan, kinds, depth.perSource, lang);
    await log(runId, msg(lang, 'running', { n: jobs.length, s: new Set(jobs.map((j) => j[0])).size }));
    const raw = await runJobs(jobs, since, part, runId, lang);
    let items = dedupe(raw);
    await log(runId, msg(lang, 'collected', { r: raw.length, u: items.length }));
    if (!items.length) throw new Error('No sources were found. Try a broader brief, more sources or an earlier year.');
    score(items, plan);
    items.sort(byScore);

    if (opts.has('trail')) {
      await step(part, 48, 'Following the citation trail');
      const trail = await followTrail(items, depth, lang, runId);
      if (trail.length) { score(trail, plan); for (const it of trail) it.score -= 0.2; items = dedupe(items.concat(trail)); items.sort(byScore); }
    }

    await step(part, 54, 'Checking source quality');
    const checked = await evidence.qualityCheck(items, depth.extract, () => alive(runId));
    if (!(await alive(runId))) throw new Stopped();
    const flagged = (f) => items.filter((it) => it.flags.includes(f)).length;
    await log(runId, msg(lang, 'quality_done', { c: checked, retracted: flagged('retracted'), preprint: flagged('preprint'), check_journal: flagged('check_journal') }));
    items.sort(byScore);

    if (opts.has('fulltext')) { await step(part, 58, 'Looking for free full texts'); await readFullTexts(items, depth, topicText, lang, part, runId); }
    if (llm.available()) await extract(items.slice(0, depth.extract), topicText, lang, part, runId);
    items.sort(byScore);
    items = items.slice(0, depth.keep);
    for (const it of items) {
      if (!(it.findings || []).length) it.findings = it.abstract ? [firstSentences(it.abstract, 2).slice(0, 500)] : [];
      it.data_points = it.data_points || [];
      it.citation = evidence.harvard(it);
      it.in_text = evidence.inText(it);
    }

    let synth = [];
    if (opts.has('synthesis') && llm.available()) { await step(part, 86, 'Mapping agreement and contradiction'); synth = await synthesize(items, plan, lang, runId); }
    if (!(await alive(runId))) throw new Stopped();
    await saveCards(runId, part, items);
    const synthJson = synth.map((s) => ({ question: s.question, claims: s.claims.map((c) => ({ claim: c.claim, note: c.note, consensus: c.consensus, support: c.support.map((x) => x.id), contradict: c.contradict.map((x) => x.id) })) }));
    let gapResult = null;
    if (opts.has('gaps')) {
      await step(part, 93, 'Finding research gaps');
      await log(runId, msg(lang, 'gaps_log', { n: items.length }));
      gapResult = await evidence.findGaps({ topic: topicText, depth: depthKey, items, plan, synthesis: synthJson, lang, llm, log: (t) => log(runId, t) });
      await log(runId, msg(lang, 'gaps_done', { n: gapResult.gaps.length }));
    }
    if (!(await alive(runId))) { await db('agent_sources').where({ run_id: runId }).del(); throw new Stopped(); }
    const nClaims = synth.reduce((s, x) => s + x.claims.length, 0);
    const high = items.filter((it) => it.tier === 'high').length;
    const summary = items.length + ' evidence cards from ' + new Set(items.flatMap((it) => it.found_in || [it.source])).size + ' sources' +
      (items.filter((it) => it.fulltext).length ? ', ' + items.filter((it) => it.fulltext).length + ' read in full' : '') + (nClaims ? '; ' + nClaims + ' claims mapped' : '') +
      (gapResult && gapResult.gaps.length ? '; ' + gapResult.gaps.length + ' research gaps' : '') + '. Tick the cards you want to use in the paper.';
    await db('agent_runs').where({ id: runId }).update({
      status: 'done', summary, confidence: high >= items.length / 2 ? 'High' : high >= items.length / 5 ? 'Medium' : 'Low',
      gaps: gapResult ? gapResult.gaps.map((g) => g.title).join('\n') : null, synthesis: JSON.stringify(synthJson), gap_data: gapResult ? JSON.stringify(gapResult) : null,
      model: (llm.available() ? llm.label() : 'none').slice(0, 80), finished_at: now()
    });
    await log(runId, msg(lang, 'done', { n: items.length }) + (nClaims ? ' · ' + msg(lang, 'claims', { n: nClaims }) : '') + (gapResult && gapResult.gaps.length ? ' · ' + msg(lang, 'gaps_done', { n: gapResult.gaps.length }) : ''));
    await db('parts').where({ id: part.id }).update({ agent_status: 'review', agent_progress: 100, agent_step: 'Evidence cards ready for review' });
    const leaders = await topicLeaders(topic.id);
    await notify(leaders, { kind: 'review', title: (part.agent_name || 'Agent') + ' finished “' + part.title + '”', body: items.length + ' evidence cards to review', link: '/topics/' + topic.id + '/agents/' + part.id });
    await audit(null, topic.id, 'agent.finished', (part.agent_name || 'Agent') + ' handed back ' + items.length + ' evidence cards for “' + part.title + '”');
  } catch (e) {
    if (e instanceof Stopped || !(await alive(runId))) return; // already stopped by the researcher or the watchdog
    // Database errors are for the log, not for the researcher.
    const shown = /\b(insert into|update|select|delete from)\b.*"|SQLITE_|violates|value too long/i.test(String(e.message)) ? 'Saving the results failed — run it again' : String(e.message);
    await db('agent_runs').where({ id: runId }).update({ status: 'failed', error: shown.slice(0, 1000), finished_at: now() });
    await db('parts').where({ id: part.id }).update({ agent_status: 'failed', agent_step: shown.slice(0, 240) });
    await log(runId, msg(lang, 'error') + ': ' + e.message);
  }
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift();
    active++;
    execute(id).catch(() => {}).finally(() => { active--; if (testHook) testHook(id); pump(); });
  }
}

async function launch(topic, part, userId, followup) {
  const runId = await db.insertId('agent_runs', { topic_id: topic.id, part_id: part.id, status: 'running', depth: DEPTH[part.agent_depth] ? part.agent_depth : 'standard', lang: part.agent_lang === 'bn' ? 'bn' : 'en', followup: followup || null, created_by: userId, started_at: now() });
  await db('parts').where({ id: part.id }).update({ agent_status: 'queued', agent_progress: 0, agent_step: 'Waiting to start' });
  await log(runId, followup ? 'Asked to dig deeper: ' + followup : 'Launched');
  queue.push(runId);
  setImmediate(pump);
  return runId;
}

// After a restart, runs that were in progress can't continue.
// Runs that failed only because the AI label didn't fit the database: their cards were saved, so give them back.
async function rescueSaved() {
  const runs = await db('agent_runs').where('status', 'failed').where((w) => w.where('error', 'like', '%value too long for type character varying%').orWhere('error', 'Saving the results failed — run it again')).select('id', 'part_id');
  for (const r of runs) {
    const n = Number((await db('agent_sources').where({ run_id: r.id }).count({ n: '*' }).first()).n);
    if (!n) continue;
    await db('agent_runs').where({ id: r.id }).update({ status: 'done', error: null, summary: n + ' evidence cards. Tick the cards you want to use in the paper.', finished_at: now() });
    const latest = await db('agent_runs').where({ part_id: r.part_id }).orderBy('id', 'desc').first('id');
    if (latest && latest.id === r.id) await db('parts').where({ id: r.part_id }).whereIn('agent_status', ['failed', 'draft']).update({ agent_status: 'review', agent_progress: 100, agent_step: 'Evidence cards ready for review' });
  }
  return runs.length;
}

async function recover() {
  try { await rescueSaved(); } catch (e) { console.error('Could not restore earlier runs:', e.message); }
  try {
    const stuck = await db('agent_runs').where({ status: 'running' }).select('id', 'part_id');
    if (!stuck.length) return;
    await db('agent_runs').whereIn('id', stuck.map((r) => r.id)).update({ status: 'failed', error: 'The server restarted while this agent was working. Run it again.', finished_at: now() });
    await db('parts').whereIn('id', stuck.map((r) => r.part_id)).whereIn('agent_status', ['queued', 'running']).update({ agent_status: 'failed', agent_step: 'Interrupted by a server restart — run it again' });
  } catch (e) { /* tables may not exist yet */ }
}

// Ends runs that have been going far too long (e.g. the server slept or a service hung). The limit depends on the depth.
const maxMinutes = (depth) => Math.max(parseInt(process.env.AGENT_MAX_MINUTES || '0', 10) || 0, (DEPTH[depth] || DEPTH.standard).minutes);
async function watchdog() {
  const running = await db('agent_runs').where({ status: 'running' }).select('id', 'part_id', 'started_at', 'depth');
  for (const r of running) {
    const max = maxMinutes(r.depth);
    if (!r.started_at || Date.now() - new Date(r.started_at).getTime() < max * 60000) continue;
    await db('agent_runs').where({ id: r.id }).update({ status: 'failed', error: 'This run took longer than ' + max + ' minutes and was stopped. Run it again — if it keeps happening, an AI or search service may be down, or try Quick depth.', finished_at: now() });
    await db('parts').where({ id: r.part_id }).whereIn('agent_status', ['queued', 'running']).update({ agent_status: 'failed', agent_step: 'Took too long — run it again' });
    await log(r.id, 'Stopped by the watchdog after ' + max + ' minutes');
  }
}
async function stop(part, userName) {
  const run = await db('agent_runs').where({ part_id: part.id, status: 'running' }).orderBy('id', 'desc').first();
  if (run) {
    await db('agent_runs').where({ id: run.id }).update({ status: 'failed', error: 'Stopped by ' + userName + '.', finished_at: now() });
    await log(run.id, 'Stopped by ' + userName);
    const i = queue.indexOf(run.id); if (i >= 0) queue.splice(i, 1);
  }
  const prev = await db('agent_runs').where({ part_id: part.id, status: 'done' }).orderBy('id', 'desc').first();
  await db('parts').where({ id: part.id }).update({ agent_status: prev ? 'review' : 'draft', agent_progress: 0, agent_step: 'Stopped' });
}

async function suggestParts(question, title) {
  const out = await llm.json(
    'You help a researcher split a research question into parts that separate AI research agents can each investigate. Reply with JSON only.',
    'Topic: ' + title + '\nResearch question: ' + question +
    '\nSuggest 3 to 6 parts. Return {"parts": [{"title": "short title", "brief": "1-2 sentences: what this agent should find out", "agent": "short agent name, e.g. Hydrology agent"}]}');
  return (out.parts || []).map((p) => ({ title: String(p.title || '').slice(0, 200), brief: String(p.brief || '').slice(0, 1000), agent: String(p.agent || '').slice(0, 100) })).filter((p) => p.title.length > 2).slice(0, 8);
}

// A saved card row with its JSON columns parsed.
const arr = (v) => { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; } };
const obj = (v, d) => { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } };
function parseCard(row) {
  return { ...row, authorsList: String(row.authors || '').split(/;\s*/).filter(Boolean), found_in: arr(row.found_in), findings: arr(row.findings), data_points: arr(row.data_points), flags: arr(row.flags),
    fulltext: !!row.fulltext, selected: !!row.selected, type: row.type || (row.kind === 'wiki' ? 'reference' : 'paper'), tier: row.tier || (row.kind === 'wiki' ? 'low' : 'high'),
    in_text: row.in_text || '(' + String(row.authors || row.title || '').split(/[;,]/)[0].trim().split(' ').pop() + ', ' + (row.year || 'n.d.') + ')', relevance: row.relevance === undefined ? null : row.relevance };
}
// Re-run the gaps finder on all or only the selected cards of a run.
async function rerunGaps(run, part, topic, selectedOnly) {
  const rows = (await db('agent_sources').where({ run_id: run.id }).orderBy('n')).map(parseCard);
  const items = (selectedOnly ? rows.filter((c) => c.selected) : rows).map((c) => ({ ...c, authors: c.authorsList }));
  if (!items.length) throw new Error('Select at least one card first.');
  const result = await evidence.findGaps({ topic: (topic.question || topic.title) + ' — ' + part.title, depth: run.depth, items, plan: obj(run.plan, {}), synthesis: obj(run.synthesis, []), lang: run.lang || 'en', llm, scope: selectedOnly ? 'selected' : 'all' });
  await db('agent_runs').where({ id: run.id }).update({ gap_data: JSON.stringify(result), gaps: result.gaps.map((g) => g.title).join('\n') });
  return result;
}

// Draft one paper section from accepted cards, using the agreement map and research gaps from the agents' runs.
async function draftSection(topic, section, items, lang) {
  const cardsText = items.map((f) => {
    const c = f.card;
    if (!c) return '- ' + f.text + ' ' + f.marks;
    const flags = (c.flags || []).map((x) => x.toUpperCase()).join(', ');
    const lines = ['CITE AS ' + f.marks + ' ' + c.in_text + ' | ' + c.title + ' | ' + (evidence.TYPE_LABELS[c.type] || c.type) + ', reliability ' + c.tier + (flags ? ' | ' + flags : ''), 'Sub-question: ' + (c.question || f.part.title)];
    for (const [l, k] of [['Method', 'method'], ['Sample', 'sample'], ['Limitations', 'limitations']]) if (c[k]) lines.push('- ' + l + ': ' + c[k]);
    for (const x of c.findings || []) lines.push('- Finding: ' + x);
    for (const x of c.data_points || []) lines.push('- Data: ' + x);
    if (!(c.findings || []).length) lines.push('- Summary: ' + f.text);
    return lines.join('\n');
  }).join('\n\n');
  const markOf = Object.fromEntries(items.filter((f) => f.card).map((f) => [f.card.id, f.marks]));
  const consensus = []; const gapLines = [];
  for (const run of [...new Map(items.filter((f) => f.run).map((f) => [f.run.id, f.run])).values()]) {
    for (const s of obj(run.synthesis, [])) for (const c of s.claims || []) {
      const sup = (c.support || []).map((i) => markOf[i]).filter(Boolean); const con = (c.contradict || []).map((i) => markOf[i]).filter(Boolean);
      if (sup.length || con.length) consensus.push('- [' + String(c.consensus).toUpperCase() + '] ' + c.claim + ' | supported by: ' + (sup.join(' ') || '-') + ' | contradicted by: ' + (con.join(' ') || '-') + (c.note ? ' | why: ' + c.note : ''));
    }
    for (const g of (obj(run.gap_data, {}) || {}).gaps || []) gapLines.push('- [' + String(g.priority).toUpperCase() + ' · ' + g.type + '] ' + g.title + ': ' + g.description + (g.research_question ? ' | research question: ' + g.research_question : ''));
  }
  const conclusionLike = /conclu|discussion|gap|future/i.test(section.title);
  const out = await llm.json(
    'You help a researcher draft one section of an academic paper from evidence cards they accepted. Use ONLY these cards. Do not add facts from elsewhere. ' +
    'Cite every claim with the citation marker shown after CITE AS on its card, e.g. [src:12], copied exactly and placed right after the sentence it supports. Reply with JSON only.',
    'Paper topic: ' + topic.title + '\nResearch question: ' + (topic.question || '') + '\nSection: ' + section.title +
    '\n\nRules:\n- Synthesise across sources: compare, contrast, note agreement and disagreement. Paraphrase rather than quote.\n- Use the CONSENSUS MAP to show where evidence is strong, mixed or rests on a single source, and why sources disagree. Mention methods and limitations where they matter.\n- Never cite a source marked RETRACTED. Describe preprints as not yet peer-reviewed.\n' +
    (conclusionLike ? '- Use the RESEARCH GAPS to discuss what is still unknown and end with suggested research questions.\n' : '') + '- ' + LANG_RULES.draft[lang === 'bn' ? 'bn' : 'en'] + '\n' +
    '\nCONSENSUS MAP:\n' + (consensus.join('\n') || '(none)') + (conclusionLike ? '\n\nRESEARCH GAPS:\n' + (gapLines.join('\n') || '(none)') : '') + '\n\nEVIDENCE CARDS:\n' + cardsText +
    '\n\nWrite 2-5 well-connected paragraphs. Return {"text": "..."} with paragraphs separated by blank lines. No headings, no reference list.');
  return String(out.text || '').trim();
}

function queueInfo() { return { queue: queue.slice(), active, concurrency: CONCURRENCY }; }

module.exports = { rescueSaved, queueInfo, launch, recover, watchdog, stop, suggestParts, draftSection, rerunGaps, parseCard, DEPTH, OPTIONS, DEFAULT_OPTIONS, keywords, firstSentences, _onFinish: (fn) => { testHook = fn; } };
