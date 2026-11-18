'use strict';
// Regression tests for the bugs fixed in the November 2026 review of the research agent (one test per bug).
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const evidence = require('../src/lib/evidence');
const research = require('../src/lib/research');
const llm = require('../src/lib/llm');
const exporter = require('../src/lib/evidence-export');
const { _internal: agent } = require('../src/lib/agent');

test('Harvard: same author and year get 2022a / 2022b; organisations, particles, three authors, books without author', () => {
  const items = [
    { type: 'book', authors: [], year: '2014', title: 'Leading Digital', venue: 'HBR Press', url: 'https://x' },
    { type: 'paper', authors: ['A Bee', 'C Dee', 'E Eff'], year: '2020', title: 'T', venue: 'J', doi: '10.1/x' },
    { type: 'report', authors: ['Australian Bureau of Statistics'], year: '2021', title: 'Census', venue: 'ABS', url: 'https://abs' },
    { type: 'paper', authors: ['Jean-Paul van der Berg'], year: '2019', title: 'T2', venue: '', doi: '' },
    { type: 'paper', authors: ['Abdur Rahman'], year: '2022', title: 'Zakat B', venue: 'J2', doi: '10.1/b' },
    { type: 'paper', authors: ['A. Rahman'], year: '2022', title: 'Zakat A', venue: 'J1', doi: '10.1/a' }
  ];
  evidence.applyCitations(items);
  const [book, three, corp, particle, rb, ra] = items;
  assert.ok(book.citation.startsWith('Leading Digital (2014). HBR Press.'), book.citation);
  assert.strictEqual(three.in_text, '(Bee, Dee and Eff, 2020)');
  assert.ok(corp.citation.startsWith('Australian Bureau of Statistics (2021)'), corp.citation);
  assert.strictEqual(particle.citation, "van der Berg, J.P. (2019) 'T2'.");
  assert.strictEqual(ra.in_text, '(Rahman, 2022a)');
  assert.strictEqual(rb.in_text, '(Rahman, 2022b)');
  assert.ok(ra.citation.includes('(2022a)'));
});

test('AI replies: lists, fenced JSON and text around JSON are all read safely', () => {
  const r = llm.parseJson('```json\n[{"id": 0, "relevance": 4}, {"id": 1}]\n```');
  assert.ok(!Array.isArray(r) && r.items.length === 2);
  assert.strictEqual(llm.parseJson('[{"title": "x"}]').title, 'x');
  assert.deepStrictEqual(llm.parseJson('Here you go: {"claims": []} done'), { claims: [] });
  assert.throws(() => llm.parseJson('no json'));
});

test('AI answers: one string instead of a list is kept, missing relevance is unknown, quotes match across spacing', () => {
  assert.deepStrictEqual(agent.list('Output rose.'), ['Output rose.']);
  const it = { score: 0, abstract: 'Adoption raised output 23 percent in Dhaka.' };
  agent.applyAnswer(it, { findings: 'Output rose.', quote: ' "Adoption raised\noutput 23" ' });
  assert.deepStrictEqual(it.findings, ['Output rose.']);
  assert.strictEqual(it.relevance, null);
  assert.ok(it.quote.startsWith('Adoption raised output'));
  agent.applyAnswer(it, ['not', 'an', 'object']); // ignored, no crash
});

test('citation trail does not relabel a paper the search found itself', () => {
  const a = { source: 'openalex', title: 'Same paper title here', doi: '10.1/x', url: '', authors: [], abstract: '', tier: 'high', found_in: ['openalex'] };
  const b = { ...a, source: 'semantic_scholar', via: 'Cited by (X, 2020)', found_in: ['citation_trail'] };
  const merged = agent.dedupe([a, b]);
  assert.strictEqual(merged.length, 1);
  assert.ok(!merged[0].via && merged[0].found_in.includes('citation_trail'));
});

test('OpenAlex without a key searches only the main topic, so its tiny free quota lasts', () => {
  const plan = { topic_query: 'zakat poverty', questions: Array.from({ length: 6 }, (_, i) => ({ question: 'Q' + i, query: 'q' + i })) };
  const key = process.env.OPENALEX_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  try {
    const jobs = agent.buildJobs(plan, ['openalex'], 5, 'en');
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0][2], 'zakat poverty');
  } finally { if (key) process.env.OPENALEX_API_KEY = key; }
});

test('sources: unsafe links dropped, DOIs normalised, DOAJ queries cleaned', async () => {
  const bad = research.item('web', 'web', 'low', 'Bad', { url: 'javascript:alert(1)', pdf_url: 'javascript:x' });
  assert.strictEqual(bad.url, ''); assert.strictEqual(bad.pdf_url, '');
  assert.strictEqual(research.item('x', 'paper', 'high', 'T', { doi: 'doi: 10.1/ABC' }).doi, '10.1/abc');
  const orig = global.fetch;
  let seen = '';
  global.fetch = async (u) => { seen = String(u); return new Response(JSON.stringify({ results: [] }), { status: 200 }); };
  try { await research.searchDoaj('impact: "zakat" (Bangladesh)/SMEs', 5); } finally { global.fetch = orig; }
  const q = decodeURIComponent(seen.split('/articles/')[1].split('?')[0]);
  assert.ok(!/[:"()/]/.test(q), q);
});

test('research gaps: "Global" is not a country; odd evidence ids do not break gaps', async () => {
  assert.deepStrictEqual(evidence.itemCountries({ country: 'Global' }), []);
  assert.deepStrictEqual(evidence.itemCountries({ country: 'Bangladesh, India' }), ['Bangladesh', 'India']);
  const items = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, type: 'paper', tier: 'high', relevance: 4, question: 'Q', title: 'P' + i, findings: ['f'], in_text: '(A, 2020)', score: 1 }));
  const fakeLlm = { available: () => true, json: async () => ({ gaps: [{ title: 'G', type: 'contextual', priority: 'high', evidence: 0 }, { title: 'H', evidence: [-1, 'x', 99] }] }) };
  const res = await evidence.findGaps({ topic: 'T', depth: 'quick', items, plan: { questions: [{ question: 'Q' }] }, synthesis: [], lang: 'en', llm: fakeLlm });
  assert.ok(res.ai && res.gaps.length === 2);
  assert.deepStrictEqual(res.gaps.find((g) => g.title === 'H').evidence, []);
});

test('exports: control characters, tables and rules in Word; control characters in Excel; no retracted references', async () => {
  const JSZip = require('jszip');
  const buf = await exporter.mdToDocx('# Title\u000c\n\n***Key*** point \u0001 here\n\n---\n\n| Study | Year |\n|---|---|\n| Smith | 2020 |\n\n1) first\n\n##### Deep\n');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.ok(xml.includes('<w:tbl>') && xml.includes('Smith') && !xml.includes('\u0001') && !xml.includes('#####') && !/>---</.test(xml));
  const card = { id: 1, type: 'paper', tier: 'high', question: 'Q', title: 'Bad\u0002title', authors: [], year: '2020', venue: 'J\u000b', findings: ['x\u0003'], data_points: [], flags: [], in_text: '(T, 2020)', citation: 'C', found_in: ['openalex'], source: 'openalex', url: '' };
  const xbuf = await exporter.matrixXlsx('T', 'en', [card], [], {});
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xbuf); // a file with illegal characters would fail to load
  const good = { ...card, title: 'Good', citation: 'GOOD REF', flags: [] };
  const bad = { ...card, id: 2, title: 'Bad', citation: 'BAD REF', flags: ['retracted'] };
  const md = exporter.evidenceMarkdown('T', 'en', [good, bad], [], null);
  const refs = md.split('## References')[1];
  assert.ok(refs.includes('GOOD REF') && !refs.includes('BAD REF'));
});

test('AI client: a used-up daily quota is skipped instead of waited on', async () => {
  const keys = { g: process.env.GEMINI_API_KEY, q: process.env.GROQ_API_KEY };
  process.env.GEMINI_API_KEY = 'k1'; process.env.GROQ_API_KEY = 'k2';
  const orig = global.fetch;
  const hits = { gemini: 0, groq: 0 };
  global.fetch = async (u) => {
    if (String(u).includes('googleapis')) { hits.gemini++; return new Response('{"error":{"message":"Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}', { status: 429 }); }
    hits.groq++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }] }), { status: 200 });
  };
  try {
    const t0 = Date.now();
    assert.strictEqual((await llm.json('s', 'p')).ok, true);
    assert.strictEqual((await llm.json('s', 'p')).ok, true);
    assert.strictEqual(hits.gemini, 1, 'Gemini asked once, then rested');
    assert.ok(Date.now() - t0 < 3000, 'no 5-second retry waits');
  } finally {
    global.fetch = orig;
    if (keys.g === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = keys.g;
    if (keys.q === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = keys.q;
  }
});
