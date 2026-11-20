'use strict';
// Step 6 · Publish. Turns a project's final paper into:
//   • a Facebook post — always Bangla, plain text, a complete summary (readers get every finding without clicking)
//   • a website article in English and one in Bangla
// written in the voice of a writer from the Style library (permission given, or a classic writer out of copyright).
// The voice changes; the facts don't: every output is checked against a fact sheet taken from the paper, numbers
// are checked by code, and nothing may be copied from the writer's samples.
const db = require('../db');
const llm = require('./llm');
const { now } = require('./util');

const FORMATS = { fb: 'Facebook · বাংলা', web_en: 'Website · English', web_bn: 'Website · বাংলা' };
const LENGTHS = { short: 250, full: 450, long: 700 };
const READERS = { public: 'the general public with no science background', students: 'university students', policy: 'policymakers and officials' };
const COPY_RUN = 8; // this many words in a row from a sample counts as copying

// ---------- small text helpers ----------
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toLatinDigits = (s) => String(s || '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
// Bangla digits everywhere except inside links and the link line itself.
function toBanglaDigits(s) {
  return String(s || '').split(/(\bhttps?:\/\/\S+|\b[\w.-]+\.(?:com|org|net|io|edu|gov|bd)(?:\/\S*)?)/i)
    .map((part, i) => (i % 2 ? part : part.replace(/[0-9]/g, (d) => BN_DIGITS[d]))).join('');
}
const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
const isBangla = (s) => { const t = String(s || ''); const bn = (t.match(/[ঀ-৿]/g) || []).length; const lat = (t.match(/[A-Za-z]/g) || []).length; return bn > lat; };
// Facebook shows no formatting: drop markdown marks but keep #hashtags.
function plainText(s) {
  return String(s || '').replace(/\r/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // markdown headings
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s*[-*•]\s+/gm, '• ').replace(/`/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
// Numbers that matter: years, decimals, percentages and anything over 10 (list numbers like "১." are ignored).
function numbersIn(text) {
  const t = toLatinDigits(text).replace(/(\d),(\d{3})/g, '$1$2');
  const out = new Set();
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const v = m[0];
    const after = t.slice(m.index + v.length, m.index + v.length + 2);
    if (/^\.\s/.test(after) && Number(v) <= 20) continue; // "১. " list item
    if (Number(v) > 10 || v.includes('.') || /^\s?%/.test(after)) out.add(String(Number(v)));
  }
  return out;
}
const sentenceWith = (text, n) => {
  const parts = String(text || '').split(/(?<=[.!?।])\s+|\n+/);
  return (parts.find((p) => numbersIn(p).has(n)) || '').trim();
};
// Everything except the sources line and a hashtag-only line (those are added by code, not written claims).
const withoutSources = (text) => String(text || '').split('\n').filter((l) => !/^\s*তথ্যসূত্র:/.test(l) && !/^\s*(#\S+\s*)+$/.test(l)).join('\n');
// Runs of COPY_RUN+ words that also appear in the writer's samples.
function copiedRuns(text, samples) {
  const norm = (s) => words(String(s).toLowerCase().replace(/[“”"'‘’.,!?।:;()\-—]/g, ' '));
  const grams = new Set();
  for (const s of samples) { const w = norm(s); for (let i = 0; i + COPY_RUN <= w.length; i++) grams.add(w.slice(i, i + COPY_RUN).join(' ')); }
  const w = norm(text); const hits = [];
  for (let i = 0; i + COPY_RUN <= w.length; i++) {
    if (grams.has(w.slice(i, i + COPY_RUN).join(' '))) { let j = i + COPY_RUN; while (j < w.length && grams.has(w.slice(j - COPY_RUN + 1, j + 1).join(' '))) j++; hits.push(w.slice(i, j).join(' ')); i = j; }
  }
  return hits;
}

// ---------- the style library ----------
// Measured by code, so the card rests on facts about the samples.
function measure(samples) {
  const text = samples.join('\n\n');
  const sentences = text.split(/(?<=[.!?।])\s+/).filter((s) => words(s).length > 1);
  const paras = samples.flatMap((s) => s.split(/\n\s*\n/)).filter((p) => p.trim());
  const avgS = sentences.length ? Math.round(words(text).length / sentences.length) : 0;
  const avgP = paras.length ? Math.round(sentences.length / paras.length * 10) / 10 : 0;
  return { words: words(text).length, sentences: sentences.length, avgSentenceWords: avgS, avgParagraphSentences: avgP, questions: (text.match(/\?/g) || []).length, bangla: isBangla(text), sadhu: /(করিয়া|হইয়া|করিতে|হইতে|ছিলেন না|করিল|হইল|তাহার|যাহা)/.test(text) };
}
const fallbackCard = (m) => [
  m.bangla ? 'Writes in Bangla' + (m.sadhu ? ' (sadhu bhasha in the samples; the agent writes modern cholito Bangla in this voice).' : '.') : 'Writes in English.',
  'Sentences average about ' + m.avgSentenceWords + ' words; paragraphs about ' + m.avgParagraphSentences + ' sentences.',
  m.questions ? 'Uses questions to the reader.' : 'Rarely asks the reader questions.'
].join(' ');

async function styleCard(samples) {
  const m = measure(samples);
  let card = fallbackCard(m), examples = samples.map((s) => words(s).slice(0, 120).join(' ')).slice(0, 2);
  if (llm.available()) {
    try {
      const out = await llm.json(
        'You describe a writer’s style so another writer can imitate the VOICE (not the content). Return JSON: {"card": "5-8 plain sentences in English describing tone, how pieces open and end, sentence and paragraph length, word choice, devices (imagery, questions, irony, stories, numbers)", "examples": ["two short passages (max 90 words each) copied exactly from the samples that best show the voice"]}. Never describe the subject matter. Measured facts: ' + JSON.stringify(m),
        samples.map((s, i) => 'SAMPLE ' + (i + 1) + ':\n' + s.slice(0, 4000)).join('\n\n'));
      if (out.card) card = String(out.card).slice(0, 2000);
      if (Array.isArray(out.examples) && out.examples.length) examples = out.examples.map((e) => String(e).slice(0, 900)).slice(0, 2);
    } catch (e) { /* the measured card stays */ }
  }
  return { card, metrics: m, examples };
}
// Out of copyright in Bangladesh and India: 60 years after the year the writer died.
const classicOk = (year) => Number.isInteger(year) && year > 1000 && year <= new Date().getFullYear() - 61;

// ---------- reading the final paper ----------
async function sourceOf(topic) {
  const paper = require('../routes/paper');
  const sections = await db('paper_sections').where({ topic_id: topic.id }).orderBy('position').orderBy('id');
  const filled = sections.filter((s) => String(s.body || '').trim());
  const { num, refs } = await paper.numbering(filled);
  const parts = filled.map((s) => ({ title: s.title, text: paper.plain(s.body, num).trim() }));
  return { title: topic.title, question: topic.question || '', parts, refs, words: parts.reduce((a, p) => a + words(p.text).length, 0) };
}
async function ready(topic) {
  const n = await db('paper_sections').where({ topic_id: topic.id }).whereRaw("coalesce(body, '') <> ''").count({ n: '*' }).first();
  return Number(n.n) > 0;
}
// Short author–year labels for the sources line, e.g. "Azhar et al. (2014)".
const shortRef = (r) => { const t = String(r.text); const m = t.match(/^([\s\S]*?)\s*\((\d{4}|n\.d\.)\)/); if (!m || m[1].length > 200) return t.slice(0, 60).replace(/\s+\S*$/, '') + '…'; const who = m[1].trim(); const first = who.split(/,| and | & /)[0].trim().replace(/\.$/, ''); return first + (first !== who.replace(/\.$/, '') ? ' et al.' : '') + ' (' + m[2] + ')'; };

// ---------- the pipeline ----------
const SYSTEM_FACTS = 'You extract facts from a research paper for science communicators. Return JSON {"facts":[{"id":1,"text":"one short factual statement in English, with its numbers, place and year","ref":"the [n] citation numbers it carries, or empty"}],"main":["the 4-8 main findings a reader must not miss, each one short sentence"]}. Only facts the paper states. Keep exact numbers. 8-30 facts.';
const styleBlock = (st) => 'VOICE TO IMITATE (do not copy its words, do not name the writer):\n' + st.card + (st.examples && st.examples.length ? '\nShort examples of the voice, for feel only:\n' + st.examples.map((e) => '— ' + e).join('\n') : '');
const factBlock = (facts) => 'FACTS — the ONLY facts you may use. Do not add numbers, places, years or claims that are not here:\n' + facts.map((f) => f.id + '. ' + f.text + (f.ref ? ' ' + f.ref : '')).join('\n');

async function factSheet(src, step) {
  // Long papers are read in groups of sections so free-tier limits aren't hit.
  const groups = []; let cur = [], n = 0;
  for (const p of src.parts) { const w = words(p.text).length; if (cur.length && n + w > 2500) { groups.push(cur); cur = []; n = 0; } cur.push(p); n += w; }
  if (cur.length) groups.push(cur);
  const facts = [], main = [];
  for (let g = 0; g < groups.length; g++) {
    await step('Reading the final paper' + (groups.length > 1 ? ' (' + (g + 1) + ' of ' + groups.length + ')' : ''));
    const out = await llm.json(SYSTEM_FACTS, 'TITLE: ' + src.title + '\nQUESTION: ' + src.question + '\n\n' + groups[g].map((p) => '## ' + p.title + '\n' + p.text).join('\n\n'));
    (out.facts || []).forEach((f) => { if (f && f.text) facts.push({ id: facts.length + 1, text: String(f.text).slice(0, 400), ref: String(f.ref || '').slice(0, 40) }); });
    (out.main || []).forEach((m) => { if (m) main.push(String(m).slice(0, 300)); });
  }
  // Code check: a fact may only carry numbers that are in the paper.
  const paperNums = numbersIn(src.parts.map((p) => p.text).join('\n') + '\n' + src.question);
  const kept = facts.filter((f) => [...numbersIn(f.text)].every((x) => paperNums.has(x)));
  kept.forEach((f, i) => { f.id = i + 1; });
  if (!kept.length) throw new Error('Couldn’t read any facts from the final paper. Check the paper has text, then try again.');
  return { facts: kept, main: main.slice(0, 8) };
}

async function writeWeb(lang, src, sheet, st, set) {
  const bn = lang === 'bn';
  const out = await llm.json(
    'You are a science writer for a public website. Write an article ' + (bn ? 'in simple, natural, modern Bangla (চলিত ভাষা) — written directly in Bangla, not translated; use Bangla digits' : 'in clear plain English') + ' for ' + READERS[set.reader] + '. ' +
    'Return JSON {"title":"headline","subtitle":"one-sentence standfirst","body":"the article: paragraphs separated by blank lines, 3-5 short section headings each on its own line starting with ## , citations as [n] using the fact\'s reference numbers"}. About 600-900 words. Use every main finding. ' + styleBlock(st),
    factBlock(sheet.facts) + '\n\nMAIN FINDINGS:\n' + sheet.main.map((m) => '- ' + m).join('\n') + '\n\nPAPER TITLE: ' + src.title);
  let body = String(out.body || '').trim();
  if (!body) throw new Error('The ' + (bn ? 'Bangla' : 'English') + ' article came back empty.');
  if (bn) body = toBanglaDigits(body).replace(/\[([০-৯,\s]+)\]/g, (m, x) => '[' + toLatinDigits(x) + ']');
  return { title: String(out.title || src.title).slice(0, 300), subtitle: String(out.subtitle || '').slice(0, 500), body };
}

function sourcesLine(src, link) {
  const names = src.refs.slice(0, 6).map(shortRef);
  return 'তথ্যসূত্র: ' + (names.length ? toBanglaDigits(names.join(', ')) : 'চূড়ান্ত গবেষণা প্রতিবেদন') + '।' + (link ? ' বিস্তারিত লেখা ও সব তথ্যসূত্র: ' + link : '');
}
async function writeFb(src, sheet, st, set, extra) {
  const target = LENGTHS[set.length] || LENGTHS.full;
  const out = await llm.json(
    'You write Facebook posts in simple, everyday Bangla (চলিত ভাষা) for ' + READERS[set.reader] + '. The post must be a COMPLETE summary: a reader who never clicks any link gets every main finding. ' +
    'Rules: plain text only — no markdown, no asterisks, no # headings, no bold. Short paragraphs separated by a blank line. Short question-style sub-headings on their own line are welcome (e.g. "কী কাজ করে?"). Lists use Bangla digits like "১." on separate lines. Use Bangla digits for numbers. Explain any technical term once in brackets in plain words. Open in the voice below, cover every main finding, end with a closing line in the voice. Do NOT write a sources line, link or hashtags — they are added after. About ' + target + ' words. ' +
    'Return JSON {"text":"the post"}. ' + styleBlock(st),
    factBlock(sheet.facts) + '\n\nMAIN FINDINGS (all must appear):\n' + sheet.main.map((m) => '- ' + m).join('\n') + (extra ? '\n\nALSO: ' + extra : ''));
  return finishFb(String(out.text || ''), src, set);
}
function finishFb(text, src, set) {
  let t = toBanglaDigits(plainText(text)).replace(/\n*তথ্যসূত্র:[\s\S]*$/, '').trim();
  if (!t) throw new Error('The Facebook post came back empty.');
  const tags = (set.hashtags || '#গবেষণা #জনস্বাস্থ্য').trim();
  return t + '\n\n' + sourcesLine(src, set.link) + (tags ? '\n' + tags : '');
}

async function coverage(fb, sheet, src, st, set) {
  if (!sheet.main.length) return fb;
  const out = await llm.json('You check whether a Bangla Facebook post covers a list of findings. Return JSON {"missing":[the numbers of findings NOT covered]}.', 'FINDINGS:\n' + sheet.main.map((m, i) => (i + 1) + '. ' + m).join('\n') + '\n\nPOST:\n' + fb);
  const miss = (out.missing || []).map(Number).filter((n) => n >= 1 && n <= sheet.main.length);
  if (!miss.length) return fb;
  const body = fb.split(/\n\nতথ্যসূত্র:/)[0];
  const fix = await llm.json('Add short plain-Bangla sentences (চলিত) to this Facebook post so it also covers the listed findings. Keep everything else, keep plain text, no markdown. Use only the facts given. Return JSON {"text":"the full post"}. ' + styleBlock(st),
    'POST:\n' + body + '\n\nADD THESE FINDINGS:\n' + miss.map((n) => '- ' + sheet.main[n - 1]).join('\n') + '\n\n' + factBlock(sheet.facts));
  return fix.text ? finishFb(fix.text, src, set) : fb;
}

// Claims: the AI marks each factual sentence; code adds any number that isn't in the paper.
async function checkClaims(output, sheet, src, samples) {
  const text = [output.title, output.subtitle, output.body].filter(Boolean).join('\n');
  const rows = [];
  try {
    const out = await llm.json('You fact-check a piece written from a fact sheet. List EVERY sentence that states a fact. For each: "quote" = the exact sentence copied from the piece, "status" = "ok" if a fact supports it, "changed" if it alters a fact (numbers, places, years, strength of a claim), "unsupported" if no fact supports it; "fact" = the supporting or altered fact number (0 if none). Return JSON {"claims":[...]}. Ignore opinions, questions and the closing line.',
      factBlock(sheet.facts) + '\n\nPIECE:\n' + withoutSources(text));
    for (const c of out.claims || []) {
      if (!c || !c.quote) continue;
      const f = sheet.facts.find((x) => x.id === Number(c.fact));
      const status = ['ok', 'changed', 'unsupported'].includes(c.status) ? c.status : 'unsupported';
      rows.push({ quote: String(c.quote).slice(0, 1000), status, fact: f ? f.text : null, source: f && f.ref ? f.ref : null });
    }
  } catch (e) { /* the code checks below still run */ }
  const paperNums = numbersIn(src.parts.map((p) => p.text).join('\n') + '\n' + src.question + '\n' + src.refs.map((r) => r.text).join('\n'));
  const body = withoutSources(text);
  for (const n of numbersIn(body)) {
    if (paperNums.has(n)) continue;
    const q = sentenceWith(body, n) || n;
    if (!rows.some((r) => r.status !== 'ok' && r.quote.includes(q.slice(0, 40)))) rows.push({ quote: q, status: 'unsupported', fact: 'The number ' + n + ' is not in the final paper.', source: null });
  }
  for (const run of copiedRuns(body, samples)) rows.push({ quote: run, status: 'copied', fact: 'These words are copied from the writer’s samples. Rewrite them in your own words.', source: null });
  return rows;
}
async function saveClaims(outputId, rows) {
  await db('publish_claims').where({ output_id: outputId }).del();
  if (rows.length) await db('publish_claims').insert(rows.map((r) => ({ output_id: outputId, quote: r.quote, status: r.status, fact: r.fact, source: r.source, resolved: false })));
}

const running = new Set();
async function execute(runId) {
  if (running.has(runId)) return;
  running.add(runId);
  const run = await db('publish_runs').where({ id: runId }).first();
  const set = JSON.parse(run.settings || '{}');
  let pct = 5;
  const step = async (s, p) => { pct = p || Math.min(95, pct + 10); await db('publish_runs').where({ id: runId }).update({ step: s, progress: pct }); };
  try {
    await db('publish_runs').where({ id: runId }).update({ status: 'running', step: 'Starting', progress: 2 });
    const topic = await db('topics').where({ id: run.topic_id }).first();
    const style = run.style_id ? await db('styles').where({ id: run.style_id }).first() : null;
    if (!style) throw new Error('That writing style was removed. Choose another style.');
    const st = { card: style.card, examples: JSON.parse(style.examples || '[]') };
    const samples = JSON.parse(style.samples || '[]');
    const src = await sourceOf(topic);
    if (!src.parts.length) throw new Error('The final paper has no text yet. Write the paper first.');
    const sheet = await factSheet(src, (s) => step(s, 15));
    await db('publish_runs').where({ id: runId }).update({ facts: JSON.stringify(sheet) });
    const make = { fb: async () => { await step('Writing the Facebook post in Bangla', 40); let fb = await writeFb(src, sheet, st, set); await step('Checking the post covers every finding', 55); try { fb = await coverage(fb, sheet, src, st, set); } catch (e) { /* keep the post */ } return { title: null, subtitle: null, body: fb }; },
      web_en: async () => { await step('Writing the English website article', 65); return writeWeb('en', src, sheet, st, set); },
      web_bn: async () => { await step('Writing the Bangla website article', 78); return writeWeb('bn', src, sheet, st, set); } };
    const ids = {};
    for (const f of set.formats) {
      const o = await make[f]();
      ids[f] = await db.insertId('publish_outputs', { run_id: runId, format: f, title: o.title, subtitle: o.subtitle, body: o.body, edited: false, updated_by: run.created_by, updated_at: now() });
    }
    await step('Checking every claim against the final paper', 88);
    for (const f of set.formats) {
      const o = await db('publish_outputs').where({ id: ids[f] }).first();
      await saveClaims(o.id, await checkClaims(o, sheet, src, samples));
    }
    await db('publish_runs').where({ id: runId }).update({ status: 'done', step: 'Ready', progress: 100, finished_at: now(), model: llm.label().slice(0, 200) });
    if (run.created_by) await require('./events').notify(run.created_by, { kind: 'update', title: 'Public versions ready: ' + topic.title, body: 'Facebook post and website articles in the ' + run.style_name + ' style', link: '/topics/' + topic.id + '/publish' });
  } catch (e) {
    await db('publish_runs').where({ id: runId }).update({ status: 'failed', step: 'Stopped', error: String(e.message || e).slice(0, 1000), finished_at: now() });
  } finally { running.delete(runId); }
}
function start(runId) { setImmediate(() => { execute(runId).catch(() => {}); }); }
// After a restart, a run that was in the middle can't continue.
async function recover() {
  await db('publish_runs').whereIn('status', ['queued', 'running']).update({ status: 'failed', step: 'Stopped', error: 'The server restarted while this was being written. Run it again.', finished_at: now() });
}

// Small follow-ups from the studio: shorter / longer / fix one claim.
async function revise(output, run, how) {
  const topic = await db('topics').where({ id: run.topic_id }).first();
  const style = await db('styles').where({ id: run.style_id }).first();
  if (!style) throw new Error('That writing style was removed.');
  const st = { card: style.card, examples: JSON.parse(style.examples || '[]') };
  const set = JSON.parse(run.settings || '{}');
  const sheet = JSON.parse(run.facts || '{"facts":[],"main":[]}');
  const src = await sourceOf(topic);
  const samples = JSON.parse(style.samples || '[]');
  let next = { title: output.title, subtitle: output.subtitle, body: output.body };
  if (how.kind === 'length') {
    const body = output.body.split(/\n\nতথ্যসূত্র:/)[0];
    const instr = how.dir === 'shorter' ? 'Make it about a third shorter but keep every main finding.' : 'Make it about a third longer with a little more explanation, using only the facts.';
    if (output.format === 'fb') {
      const out = await llm.json('Rewrite this Bangla Facebook post. ' + instr + ' Keep plain text, simple চলিত Bangla, no markdown, Bangla digits. Return JSON {"text":"the post"}. ' + styleBlock(st), 'POST:\n' + body + '\n\n' + factBlock(sheet.facts));
      next.body = finishFb(out.text || body, src, set);
    } else {
      const out = await llm.json('Rewrite this website article. ' + instr + ' Keep the same language, the ## headings and [n] citations. Return JSON {"body":"the article"}. ' + styleBlock(st), 'ARTICLE:\n' + output.body + '\n\n' + factBlock(sheet.facts));
      if (out.body) next.body = output.format === 'web_bn' ? toBanglaDigits(out.body).replace(/\[([০-৯,\s]+)\]/g, (m, x) => '[' + toLatinDigits(x) + ']') : String(out.body);
    }
  } else if (how.kind === 'fix') {
    const out = await llm.json('Rewrite ONE sentence so it says only what the fact says. Same language as the sentence, same voice, ' + (output.format === 'web_en' ? 'plain English' : 'simple চলিত Bangla with Bangla digits') + '. Return JSON {"sentence":"..."}.', 'SENTENCE: ' + how.quote + '\nFACT: ' + (how.fact || 'Remove anything the fact sheet does not support.') + '\n\n' + factBlock(sheet.facts));
    const s = String(out.sentence || '').trim();
    if (!s || !output.body.includes(how.quote)) throw new Error('Couldn’t find that sentence any more — it may have been edited.');
    next.body = output.body.replace(how.quote, output.format === 'web_en' ? s : toBanglaDigits(s));
  }
  await db('publish_outputs').where({ id: output.id }).update({ title: next.title, subtitle: next.subtitle, body: next.body, updated_at: now(), edited: true });
  await saveClaims(output.id, await checkClaims({ ...output, ...next }, sheet, src, samples));
}
// After a hand edit: check again. The code checks (numbers, copying) always run; the AI check when it's connected.
async function quickCheck(output, run) {
  const style = run.style_id ? await db('styles').where({ id: run.style_id }).first() : null;
  const topic = await db('topics').where({ id: run.topic_id }).first();
  const src = await sourceOf(topic);
  const sheet = JSON.parse(run.facts || '{"facts":[],"main":[]}');
  await saveClaims(output.id, await checkClaims(output, sheet, src, style ? JSON.parse(style.samples || '[]') : []));
}

// Website article as HTML (for "Copy as HTML") and as a Word document.
const escH = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function articleHtml(o, refs) {
  const bodyHtml = String(o.body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => (/^##\s+/.test(p) ? '<h2>' + escH(p.replace(/^##\s+/, '')) + '</h2>' : '<p>' + escH(p).replace(/\[(\d+(?:,\s*\d+)*)\]/g, '<sup>[$1]</sup>').replace(/\n/g, '<br>') + '</p>')).join('\n');
  const refHead = o.format === 'web_bn' ? 'তথ্যসূত্র' : 'References';
  return '<article>\n<h1>' + escH(o.title) + '</h1>\n' + (o.subtitle ? '<p><em>' + escH(o.subtitle) + '</em></p>\n' : '') + bodyHtml +
    (refs.length ? '\n<h2>' + refHead + '</h2>\n<ol>\n' + refs.map((r) => '<li>' + escH(r.text) + (r.url ? ' <a href="' + escH(r.url) + '">' + escH(r.url) + '</a>' : '') + '</li>').join('\n') + '\n</ol>' : '') + '\n</article>';
}
function articleText(o, refs) {
  return [o.title, o.subtitle, '', String(o.body || '').replace(/^##\s+/gm, ''), '', refs.length ? (o.format === 'web_bn' ? 'তথ্যসূত্র' : 'References') : '', ...refs.map((r) => '[' + r.n + '] ' + r.text)].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').trim();
}
async function articleDocx(o, refs) {
  const D = require('docx');
  const font = o.format === 'web_bn' ? 'Nirmala UI' : 'Calibri';
  const kids = [new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: o.title || '', font })] })];
  if (o.subtitle) kids.push(new D.Paragraph({ children: [new D.TextRun({ text: o.subtitle, italics: true, font })] }));
  for (const p of String(o.body || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
    if (/^##\s+/.test(p)) kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: [new D.TextRun({ text: p.replace(/^##\s+/, ''), font })] }));
    else kids.push(new D.Paragraph({ spacing: { after: 160 }, children: [new D.TextRun({ text: p.replace(/\n/g, ' '), font })] }));
  }
  if (refs.length) {
    kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: [new D.TextRun({ text: o.format === 'web_bn' ? 'তথ্যসূত্র' : 'References', font })] }));
    refs.forEach((r) => kids.push(new D.Paragraph({ children: [new D.TextRun({ text: '[' + r.n + '] ' + r.text, size: 20 })] })));
  }
  return D.Packer.toBuffer(new D.Document({ sections: [{ children: kids }] }));
}

module.exports = { FORMATS, LENGTHS, READERS, styleCard, measure, classicOk, sourceOf, ready, start, execute, recover, revise, quickCheck, articleHtml, articleText, articleDocx, _t: { toBanglaDigits, toLatinDigits, plainText, numbersIn, copiedRuns, shortRef, finishFb } };
