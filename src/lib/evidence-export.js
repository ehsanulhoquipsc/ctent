'use strict';
// Exports for one agent's evidence: evidence pack (.md/.docx), research gaps brief (.md/.docx) and the
// literature review matrix (.xlsx). Ported from the standalone CTENT Research Agent (exporter.py, matrix.py).
const ev = require('./evidence');
const research = require('./research');

const today = () => new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
const srcText = (it) => it.via || (it.found_in && it.found_in.length ? it.found_in : [it.source]).map(research.label).join(', ');

function gapLines(gaps, lang, byId) {
  const L = (k, kw) => ev.msg(lang, k, kw);
  const out = [];
  gaps.forEach((g, i) => {
    out.push('### ' + (i + 1) + '. ' + g.title, '', '**' + L('g_priority') + ':** ' + ev.priorityLabel(lang, g.priority) + ' · **' + L('g_type') + ':** ' + ev.gapTypeLabel(lang, g.type), '');
    if (g.description) out.push(g.description, '');
    if (g.signal) out.push('**' + L('g_signal') + ':** ' + g.signal, '');
    const e = (g.evidence || []).map((id) => byId[id]).filter(Boolean).map((x) => x.in_text);
    if (e.length) out.push('**' + L('g_evidence') + ':** ' + e.join(', '), '');
    if (g.research_question) out.push('**' + L('g_rq') + ':** ' + g.research_question, '');
    if (g.method) out.push('**' + L('g_method') + ':** ' + g.method, '');
  });
  return out;
}

function gapsMarkdown(title, lang, result, items) {
  const L = (k, kw) => ev.msg(lang, k, kw);
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  const st = result.stats || {};
  const gaps = result.gaps || [];
  const out = ['# ' + L('gb_title') + ': ' + title, '', L('gb_generated', { d: today(), n: st.n_relevant || items.length }), '', '> ' + L('gb_note'), '', '## ' + L('gb_snapshot'), ''];
  for (const c of st.coverage || []) out.push('- **' + c.question + '**: ' + L('gb_cov', { n: c.n, h: c.high, f: c.full }) + (c.thin ? ' · **' + L('cov_thin') + '**' : ''));
  if ((st.coverage || []).length) out.push('');
  if ((st.methods || []).length) out.push('**' + L('gb_methods') + ':** ' + st.methods.map(([m, n]) => ev.methodLabel(lang, m) + ' (' + n + ')').join(', '), '');
  if ((st.countries || []).length) out.push('**' + L('gb_countries') + ':** ' + st.countries.slice(0, 10).map(([c, n]) => c + ' (' + n + ')').join(', '), '');
  const y = st.years || {};
  if (y.n) out.push('**' + L('gb_years') + ':** ' + y.oldest + '–' + y.newest + ', median ' + y.median + ', ' + y.recent + '/' + y.n + ' ≥ ' + y.recent_from, '');
  out.push('## ' + L('gb_gaps'), '', ...gapLines(gaps, lang, byId));
  const rqs = gaps.map((g) => g.research_question).filter(Boolean);
  if (rqs.length) out.push('## ' + L('gb_rqs'), '', ...rqs.map((q, i) => (i + 1) + '. ' + q), '');
  const cited = [...new Set(gaps.flatMap((g) => g.evidence || []))].map((id) => byId[id]).filter(Boolean);
  if (cited.length) out.push('## ' + L('references'), '', ...[...new Set(cited.map((x) => x.citation))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  return out.join('\n') + '\n';
}

function evidenceMarkdown(title, lang, items, questions, gapResult) {
  const L = (k, kw) => ev.msg(lang, k, kw);
  const out = ['# ' + L('pack_title') + ': ' + title, '', L('generated', { d: today(), n: items.length }), ''];
  if (questions.length) out.push('## ' + L('questions'), '', ...questions.map((q) => '- ' + q), '');
  if (gapResult && (gapResult.gaps || []).length) out.push('## ' + L('gb_gaps'), '', '> ' + L('gb_note'), '', ...gapLines(gapResult.gaps, lang, Object.fromEntries(items.map((it) => [it.id, it]))));
  const groups = new Map();
  for (const it of items) { const q = it.question || 'General'; if (!groups.has(q)) groups.set(q, []); groups.get(q).push(it); }
  for (const [q, group] of groups) {
    out.push('## ' + q, '');
    for (const it of group) {
      let meta = '**' + L('type') + ':** ' + ev.typeLabel(lang, it.type) + ' · **' + L('reliability') + ':** ' + ev.tierLabel(lang, it.tier) + ' · **' + L('found_in') + ':** ' + srcText(it);
      if (it.cited_by) meta += ' · **' + L('cited_by') + ':** ' + it.cited_by;
      if (it.relevance !== null && it.relevance !== undefined) meta += ' · **' + L('relevance') + ':** ' + it.relevance + '/5';
      out.push('### ' + it.title, '', meta, '');
      if ((it.flags || []).length) out.push('**⚠ ' + it.flags.map((f) => ev.flagLabel(lang, f)).join(' · ') + '**', '');
      if (it.method) out.push('**' + L('m_method') + ':** ' + it.method, '');
      if (it.sample) out.push('**' + L('m_sample') + ':** ' + it.sample, '');
      if (it.limitations) out.push('**' + L('m_limits') + ':** ' + it.limitations, '');
      if (it.future) out.push('**' + L('m_future') + ':** ' + it.future, '');
      if ((it.findings || []).length) out.push('**' + L('findings') + ':**', '', ...it.findings.map((f) => '- ' + f), '');
      if ((it.data_points || []).length) out.push('**' + L('data') + ':**', '', ...it.data_points.map((d) => '- ' + d), '');
      if (it.quote) out.push('> "' + it.quote + '"', '');
      out.push('**' + L('cite_as') + ':** ' + it.in_text, '', '**' + L('reference') + ':** ' + (it.citation || ''), '');
      if (it.url) out.push('**' + L('link') + ':** ' + it.url, '');
    }
  }
  out.push('## ' + L('references'), '', ...[...new Set(items.map((it) => it.citation).filter(Boolean))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  return out.join('\n') + '\n';
}

// Simple Markdown (headings, bullets, numbered lists, quotes, **bold**, *italic*) to a Word document.
async function mdToDocx(md) {
  const D = require('docx');
  const runs = (text) => text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/).filter(Boolean).map((p) => {
    if (/^\*\*.*\*\*$/.test(p)) return new D.TextRun({ text: p.slice(2, -2), bold: true });
    if (/^\*.*\*$/.test(p) && p.length > 2) return new D.TextRun({ text: p.slice(1, -1), italics: true });
    return new D.TextRun(p);
  });
  const children = [];
  let inRefs = false;
  for (const line of md.split('\n')) {
    const s = line.trimEnd();
    if (!s.trim()) continue;
    const h = s.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const text = h[2].replace(/\*/g, '');
      const level = [D.HeadingLevel.TITLE, D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3][h[1].length - 1];
      children.push(new D.Paragraph({ text, heading: level }));
      inRefs = /^(references|reference list|তথ্যসূত্র)/i.test(text);
      continue;
    }
    if (/^\s*[-*]\s+/.test(s)) children.push(new D.Paragraph({ children: runs(s.replace(/^\s*[-*]\s+/, '')), bullet: { level: 0 } }));
    else if (/^\s*\d+\.\s+/.test(s)) children.push(new D.Paragraph({ children: runs(s), indent: { left: 360 } }));
    else if (s.startsWith('>')) children.push(new D.Paragraph({ children: [new D.TextRun({ text: s.replace(/^>\s*/, ''), italics: true })], indent: { left: 540 } }));
    else children.push(new D.Paragraph({ children: runs(s), spacing: { after: 120 }, ...(inRefs ? { indent: { left: 720, hanging: 720 } } : {}) }));
  }
  const doc = new D.Document({ styles: { default: { document: { run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Nirmala UI' }, size: 22 } } } }, sections: [{ children }] });
  return D.Packer.toBuffer(doc);
}

// Literature review matrix: Matrix, Consensus map, Data points, Research gaps, Coverage and Charts data sheets.
async function matrixXlsx(title, lang, items, synthesis, gapResult) {
  const ExcelJS = require('exceljs');
  const L = (k) => ev.msg(lang, k);
  const font = lang === 'bn' ? 'Nirmala UI' : 'Calibri';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CTENT';
  const sheet = (name, headers, widths, rows, opts = {}) => {
    const ws = wb.addWorksheet(String(name).slice(0, 31));
    ws.columns = headers.map((h, i) => ({ header: h, width: widths[i] }));
    const head = ws.getRow(1);
    head.height = 30;
    head.eachCell((c) => { c.font = { name: font, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8E2433' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    rows.forEach((row, i) => {
      const r = ws.addRow(row);
      r.eachCell({ includeEmpty: true }, (c) => { c.font = { name: font, size: 10 }; c.alignment = { vertical: 'top', wrapText: true }; if (i % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F4F1' } }; });
      if (opts.fill) opts.fill(r, i);
    });
    ws.views = [{ state: 'frozen', xSplit: headers.length > 6 ? 2 : 0, ySplit: 1 }];
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: headers.length } };
    return ws;
  };
  const bullets = (xs) => (xs || []).map((x) => '• ' + x).join('\n');
  const keys = ['m_no', 'm_cite', 'm_authors', 'm_year', 'm_title_col', 'm_venue', 'm_type', 'm_question', 'm_method', 'm_sample', 'm_findings', 'm_data', 'm_limits', 'm_tier', 'm_flags', 'm_cited', 'm_full', 'm_via', 'm_link', 'm_ref', 'm_mtype', 'm_country', 'm_future'];
  const ws = sheet(L('m_title'), keys.map(L), [5, 22, 24, 7, 40, 24, 12, 30, 26, 26, 55, 40, 30, 11, 18, 9, 9, 22, 30, 60, 18, 18, 34], items.map((it, i) => [
    i + 1, it.in_text, (it.authorsList || []).slice(0, 6).join('; ') + ((it.authorsList || []).length > 6 ? ' et al.' : ''), it.year || 'n.d.', it.title, it.venue || '', ev.typeLabel(lang, it.type), it.question || '',
    it.method || '', it.sample || '', bullets(it.findings), bullets(it.data_points), it.limitations || '', ev.tierLabel(lang, it.tier), (it.flags || []).map((f) => ev.flagLabel(lang, f)).join('; '), it.cited_by || '',
    it.fulltext ? L('yes') : L('no'), srcText(it), it.url || '', it.citation || '', ev.classifyMethod(it) ? ev.methodLabel(lang, ev.classifyMethod(it)) : '', ev.itemCountries(it).join(', '), it.future || ''
  ]), { fill: (r, i) => { if ((items[i].flags || []).length) r.getCell(15).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBE3E3' } }; const u = items[i].url; if (u) { r.getCell(19).value = { text: u, hyperlink: u }; r.getCell(19).font = { name: font, size: 10, color: { argb: 'FF0B4F8A' }, underline: true }; } } });
  void ws;
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  const CONS = { strong: 'FFDDF1E4', moderate: 'FFEAF4D9', mixed: 'FFFDF1D6', contested: 'FFFBE3E3', single: 'FFEEEEEE' };
  const rows2 = []; const cons2 = [];
  for (const s of synthesis || []) for (const c of s.claims || []) {
    const sup = (c.support || []).map((i) => byId[i]).filter(Boolean).map((x) => x.in_text); const con = (c.contradict || []).map((i) => byId[i]).filter(Boolean).map((x) => x.in_text);
    if (sup.length || con.length) { rows2.push([s.question, c.claim, ev.consensusLabel(lang, c.consensus), sup.join('\n'), con.join('\n'), c.note || '']); cons2.push(c.consensus); }
  }
  sheet(L('s_consensus'), [L('m_question'), L('s_claim'), L('s_level'), L('s_support'), L('s_contra'), L('s_note')], [30, 60, 14, 26, 26, 45], rows2, { fill: (r, i) => { r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CONS[cons2[i]] || CONS.single } }; } });
  sheet(L('s_data'), [L('m_cite'), L('m_data'), L('m_question'), L('m_tier'), L('m_link')], [24, 70, 34, 12, 34], items.flatMap((it) => (it.data_points || []).map((d) => [it.in_text, d, it.question || '', ev.tierLabel(lang, it.tier), it.url || ''])));
  if (gapResult && (gapResult.gaps || []).length) {
    const PRIO = { high: 'FFFBE3E3', medium: 'FFFDF1D6', low: 'FFEEEEEE' };
    sheet(L('s_gaps'), ['g_priority', 'g_type', 'g_gap', 'g_desc', 'g_signal', 'g_evidence', 'g_rq', 'g_method'].map(L), [11, 18, 40, 60, 36, 24, 50, 40],
      gapResult.gaps.map((g) => [ev.priorityLabel(lang, g.priority), ev.gapTypeLabel(lang, g.type), g.title, g.description || '', g.signal || '', (g.evidence || []).map((i) => byId[i]).filter(Boolean).map((x) => x.in_text).join('\n'), g.research_question || '', g.method || '']),
      { fill: (r, i) => { r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIO[gapResult.gaps[i].priority] || PRIO.low } }; } });
    const cov = (gapResult.stats || {}).coverage || [];
    sheet(L('s_coverage'), [L('m_question'), 'n', L('m_tier') + ': ' + ev.tierLabel(lang, 'high'), L('m_full'), L('m_data'), L('cov_thin')], [60, 8, 16, 14, 12, 16], cov.map((c) => [c.question, c.n, c.high, c.full, c.data, c.thin ? L('cov_thin') : '']));
  }
  // Chart data: Excel's own charts can be inserted from these tables in two clicks (Insert → Chart).
  const blocks = [
    [L('m_year'), ev.count(items.map((it) => it.year).filter(Boolean).map(String)).sort((a, b) => a[0] - b[0])],
    [L('m_tier'), ev.count(items.map((it) => ev.tierLabel(lang, it.tier)))],
    ['Source', ev.count(items.flatMap((it) => (it.found_in && it.found_in.length ? it.found_in : [it.source]).map(research.label))).slice(0, 12)],
    [L('m_mtype'), ev.count(items.filter((it) => it.type === 'paper').map(ev.classifyMethod).filter(Boolean).map((m) => ev.methodLabel(lang, m)))],
    [L('m_country'), ev.count(items.filter((it) => ['paper', 'report', 'book'].includes(it.type)).flatMap(ev.itemCountries)).slice(0, 12)]
  ];
  const ws4 = wb.addWorksheet(L('s_charts').slice(0, 31));
  blocks.forEach(([t, data], b) => {
    const col = b * 3 + 1;
    ws4.getColumn(col).width = 28;
    ws4.getCell(1, col).value = t; ws4.getCell(1, col).font = { name: font, bold: true };
    ws4.getCell(1, col + 1).value = 'n'; ws4.getCell(1, col + 1).font = { name: font, bold: true };
    data.forEach(([k, v], i) => { ws4.getCell(i + 2, col).value = k; ws4.getCell(i + 2, col + 1).value = v; });
  });
  void title;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { evidenceMarkdown, gapsMarkdown, mdToDocx, matrixXlsx };
