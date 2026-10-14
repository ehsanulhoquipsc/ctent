'use strict';
// The public showcase website: plain HTML + CSS pages (no JavaScript) built from finished papers.
// Each page is self-contained, so it can be dropped into any static host (GitHub Pages, Netlify, cPanel).
const { esc } = require('./util');

const SITE = () => process.env.SHOWCASE_NAME || 'CTENT Research';
const TAGLINE = () => process.env.SHOWCASE_TAGLINE || 'Research papers from the CTENT research group';

const CSS = `
:root{--ink:#16130f;--ink2:#4a453f;--muted:#7a736b;--line:#e3ddd5;--paper:#fffdf9;--bg:#f5f1ea;--accent:#8e2433;--accent-soft:#f3e6e6;--serif:'Source Serif 4',Georgia,'Times New Roman',serif;--sans:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
@media (prefers-color-scheme:dark){:root{--ink:#f1ece4;--ink2:#cfc7bc;--muted:#9c948a;--line:#3a352f;--paper:#1c1916;--bg:#14120f;--accent:#e08a96;--accent-soft:#3a2327}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.7 var(--serif)}
a{color:var(--accent)}a:hover{color:var(--ink)}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header.site{border-bottom:1px solid var(--line);background:var(--paper)}
header.site .wrap{display:flex;align-items:center;gap:20px;min-height:68px;flex-wrap:wrap}
.brand{font:700 18px/1 var(--sans);letter-spacing:-.01em;color:var(--ink);text-decoration:none;display:flex;align-items:center;gap:10px}
.brand i{width:12px;height:12px;border-radius:3px;background:var(--accent);display:inline-block}
nav.top{margin-left:auto;display:flex;gap:22px;font:500 14px var(--sans)}nav.top a{color:var(--ink2);text-decoration:none}nav.top a:hover,nav.top a[aria-current]{color:var(--accent)}
.kicker{font:600 12px/1.4 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.hero{padding:64px 0 40px}.hero h1{font:600 clamp(32px,5vw,52px)/1.1 var(--serif);margin:10px 0 14px;letter-spacing:-.015em;max-width:780px}
.hero p{font:400 19px/1.6 var(--sans);color:var(--ink2);max-width:640px;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;padding-bottom:64px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:10px;text-decoration:none;color:var(--ink);transition:border-color .15s}
.card:hover{border-color:var(--accent);color:var(--ink)}
.card h2{font:600 21px/1.3 var(--serif);margin:0}.card p{margin:0;font:400 15px/1.6 var(--sans);color:var(--ink2)}
.meta{font:500 13px/1.5 var(--sans);color:var(--muted)}
.more{margin-top:auto;font:600 14px var(--sans);color:var(--accent)}
.empty{padding:48px;text-align:center;border:1.5px dashed var(--line);border-radius:14px;font-family:var(--sans);color:var(--muted)}
article.paper{background:var(--paper);border:1px solid var(--line);border-radius:16px;margin:40px auto 64px;max-width:820px;padding:56px clamp(20px,6vw,72px)}
article.paper h1{font:600 clamp(28px,4.4vw,42px)/1.15 var(--serif);margin:12px 0 16px;letter-spacing:-.01em}
.authors{font:500 16px/1.6 var(--sans);color:var(--ink2);margin:0}
.facts{display:flex;flex-wrap:wrap;gap:8px 18px;font:500 13px/1.5 var(--sans);color:var(--muted);margin:14px 0 28px;padding-bottom:24px;border-bottom:1px solid var(--line)}
.box{background:var(--accent-soft);border-radius:12px;padding:18px 22px;margin:0 0 22px}
.box .kicker{margin-bottom:6px}.box p{margin:0}
.abstract{font-size:16.5px}
.toc{font:400 15px/1.8 var(--sans);margin:0 0 32px;padding:18px 22px;border:1px solid var(--line);border-radius:12px}
.toc ol{margin:6px 0 0;padding-left:20px}.toc a{color:var(--ink2);text-decoration:none}.toc a:hover{color:var(--accent)}
article.paper h2{font:600 25px/1.3 var(--serif);margin:40px 0 10px;scroll-margin-top:20px}
article.paper p{margin:0 0 16px}
sup.ref{font:600 11px var(--sans);line-height:0}sup.ref a{text-decoration:none}
ol.refs{font:400 14.5px/1.6 var(--sans);color:var(--ink2);padding-left:24px}ol.refs li{margin-bottom:10px;word-break:break-word}
footer.site{border-top:1px solid var(--line);font:400 14px/1.6 var(--sans);color:var(--muted);padding:28px 0}
.about{max-width:720px;padding:56px 0}.about h1{font:600 40px/1.15 var(--serif);margin:10px 0 18px}.about p{font:400 18px/1.7 var(--sans);color:var(--ink2)}
@media print{header.site,footer.site,.toc{display:none}body{background:#fff}article.paper{border:0;margin:0;padding:0;max-width:none}}
@media (max-width:640px){body{font-size:16px}.hero{padding:40px 0 28px}article.paper{border-radius:0;border-left:0;border-right:0;margin:0 0 32px}}
`;

function slug(t) {
  return (String(t.code || 'paper') + '-' + String(t.title || '')).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}
const fmtDate = (d) => { const x = d ? new Date(d) : new Date(); return isNaN(x) ? '' : x.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }); };

function page({ title, description, body, root, active }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || TAGLINE())}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<header class="site"><div class="wrap"><a class="brand" href="${root}index.html"><i></i>${esc(SITE())}</a><nav class="top" aria-label="Main"><a href="${root}index.html"${active === 'papers' ? ' aria-current="page"' : ''}>Papers</a><a href="${root}about.html"${active === 'about' ? ' aria-current="page"' : ''}>About</a></nav></div></header>
<main>${body}</main>
<footer class="site"><div class="wrap">© ${new Date().getFullYear()} ${esc(SITE())}. Papers prepared with CTENT — Conducting from Interior.</div></footer>
</body>
</html>
`;
}

// data: { topic, authors: [names], sections: [{title, html}], refs: [{n, text, url}], abstract }
function paperPage(d) {
  const t = d.topic;
  const secs = d.sections.filter((s) => !/^abstract$/i.test(s.title));
  const toc = secs.length > 2 ? `<nav class="toc" aria-label="Contents"><span class="kicker">Contents</span><ol>${secs.map((s, i) => `<li><a href="#s${i + 1}">${esc(s.title)}</a></li>`).join('')}${d.refs.length ? '<li><a href="#references">References</a></li>' : ''}</ol></nav>` : '';
  const body = `<div class="wrap"><article class="paper">
<p style="margin:0;font:500 14px var(--sans)"><a href="../index.html" style="text-decoration:none">← All papers</a></p>
<div class="kicker" style="margin-top:22px">${esc(t.field || 'Research paper')}</div>
<h1>${esc(t.final_title || t.title)}</h1>
${d.authors.length ? `<p class="authors">${d.authors.map(esc).join(', ')}</p>` : ''}
<div class="facts"><span>${esc(t.code)}</span><span>Published ${esc(fmtDate(t.completed_at || t.showcase_at))}</span>${d.refs.length ? `<span>${d.refs.length} references</span>` : ''}</div>
${t.question ? `<div class="box"><div class="kicker">Research question</div><p>${esc(t.question)}</p></div>` : ''}
${d.abstract ? `<div class="box abstract" style="background:transparent;border:1px solid var(--line)"><div class="kicker">Abstract</div>${d.abstract}</div>` : ''}
${toc}
${secs.length ? '' : '<p class="meta">No sections have been written yet.</p>'}
${secs.map((s, i) => `<section><h2 id="s${i + 1}">${esc(s.title)}</h2>${s.html}</section>`).join('\n')}
${d.refs.length ? `<section><h2 id="references">References</h2><ol class="refs">${d.refs.map((r) => `<li id="ref${r.n}">${r.url ? `<a href="${esc(r.url)}" rel="noopener">${esc(r.text)}</a>` : esc(r.text)}</li>`).join('')}</ol></section>` : ''}
</article></div>`;
  return page({ title: (t.final_title || t.title) + ' — ' + SITE(), description: d.abstractText || t.question || t.description, body, root: '../', active: 'papers' });
}

// items: [{ topic, authors, abstractText }]
function indexPage(items) {
  const cards = items.map((it) => `<a class="card" href="papers/${slug(it.topic)}.html">
<span class="kicker">${esc(it.topic.field || 'Research paper')}</span>
<h2>${esc(it.topic.final_title || it.topic.title)}</h2>
${it.authors.length ? `<span class="meta">${it.authors.map(esc).join(', ')}</span>` : ''}
${it.abstractText ? `<p>${esc(it.abstractText.length > 260 ? it.abstractText.slice(0, 257).replace(/\s+\S*$/, '') + '…' : it.abstractText)}</p>` : ''}
<span class="meta">${esc(fmtDate(it.topic.completed_at || it.topic.showcase_at))}</span>
<span class="more">Read the paper →</span>
</a>`).join('\n');
  const body = `<div class="wrap"><section class="hero"><div class="kicker">${items.length} paper${items.length === 1 ? '' : 's'}</div><h1>${esc(SITE())}</h1><p>${esc(TAGLINE())}</p></section>
${items.length ? `<div class="grid">${cards}</div>` : '<div class="empty" style="margin-bottom:64px">No papers published yet.</div>'}</div>`;
  return page({ title: SITE() + ' — Papers', body, root: '', active: 'papers' });
}

function aboutPage() {
  const body = `<div class="wrap"><section class="about"><div class="kicker">About</div><h1>About ${esc(SITE())}</h1>
<p>${esc(TAGLINE())}. Each paper begins with a research question. The question is split into parts, AI research agents gather and summarise published evidence for each part, and the researchers check every finding before writing the paper themselves.</p>
<p>Every claim in a paper links to its source in the reference list, so readers can check the evidence.</p>
${process.env.SHOWCASE_CONTACT ? `<p>Contact: ${esc(process.env.SHOWCASE_CONTACT)}</p>` : ''}</section></div>`;
  return page({ title: 'About — ' + SITE(), body, root: '', active: 'about' });
}

module.exports = { paperPage, indexPage, aboutPage, slug, CSS, SITE };
