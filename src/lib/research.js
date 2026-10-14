'use strict';
// Free research sources the agents search. Every search function returns items in one shared shape (see item()).
// Ported from the standalone CTENT Research Agent (research-agent/sources.py).
const { XMLParser } = require('fast-xml-parser');

const CONTACT = () => process.env.CONTACT_EMAIL || '';
const UA = () => 'CTENT-research-agent/2.0 (+https://github.com/ehsanulhoquipsc/ctent' + (CONTACT() ? '; mailto:' + CONTACT() : '') + ')';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Minimum milliseconds between calls to each service (their published rate limits).
const MIN_INTERVAL = { openalex: 150, semantic_scholar: 1100, crossref: 200, arxiv: 3100, pubmed: 400, europepmc: 200, doaj: 300, core: 1000,
  openlibrary: 400, googlebooks: 400, wikipedia: 200, worldbank: 500, quran: 500, ddg: 2000, unpaywall: 200, fulltext: 300 };
const nextAt = {};
const FAST = process.env.NODE_ENV === 'test'; // tests mock every service, so no waiting
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));
async function throttle(name) {
  const gap = FAST ? 0 : MIN_INTERVAL[name] || 0;
  const t = Date.now();
  const at = Math.max(t, nextAt[name] || 0);
  nextAt[name] = at + gap;
  if (at > t) await sleep(at - t);
}

class HttpError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

// GET (or POST) with a timeout, a polite user agent and a couple of retries when a service is busy.
async function request(name, url, { params, headers, as = 'json', retries = 2, emptyOn404 = false, method = 'GET', body, timeout = 25000 } = {}) {
  const u = params ? url + (url.includes('?') ? '&' : '?') + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : url;
  let err;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(name);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res;
    try {
      res = await fetch(u, { method, body, headers: { 'user-agent': UA(), ...(as === 'json' ? { accept: 'application/json' } : {}), ...(headers || {}) }, signal: ctl.signal });
    } catch (e) {
      err = new HttpError(e.name === 'AbortError' ? 'timed out' : (e.message || 'network error'));
      clearTimeout(timer);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    try {
      if (res.status === 404 && emptyOn404) return as === 'json' ? {} : '';
      if (res.status === 429 || res.status >= 500) { err = new HttpError('HTTP ' + res.status + ' (busy or rate limited)', res.status); await sleep(2500 * (attempt + 1)); continue; }
      if ([401, 402, 403, 409].includes(res.status)) throw new HttpError('HTTP ' + res.status + ' — needs an API key or the free daily quota is used up', res.status);
      if (!res.ok) throw new HttpError('HTTP ' + res.status, res.status);
      if (as === 'json') return await res.json();
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      return await res.text();
    } finally { clearTimeout(timer); }
  }
  throw err;
}

const decode = (s) => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
function clean(s) {
  if (s === null || s === undefined) return '';
  if (Array.isArray(s)) s = s.filter(Boolean).map((x) => (typeof x === 'object' ? textOf(x) : x)).join(' ');
  if (typeof s === 'object') s = textOf(s);
  return decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function textOf(x) { // text content of a parsed XML node
  if (x === null || x === undefined) return '';
  if (typeof x !== 'object') return String(x);
  if (Array.isArray(x)) return x.map(textOf).join(' ');
  return Object.entries(x).filter(([k]) => !k.startsWith('@_')).map(([, v]) => textOf(v)).join(' ');
}
const yearOf = (v) => { const m = String(v || '').match(/(1[5-9]\d\d|20\d\d)/); return m ? m[1] : ''; };

function item(source, type, tier, title, o = {}) {
  const doi = String(o.doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  return {
    source, type, tier, title: clean(title) || '(untitled)',
    authors: (o.authors || []).map(clean).filter(Boolean), year: yearOf(o.year), venue: clean(o.venue), abstract: clean(o.abstract),
    url: o.url || (doi ? 'https://doi.org/' + doi : ''), doi, citations: Number.isFinite(+o.citations) && o.citations !== null && o.citations !== '' ? Math.round(+o.citations) : null,
    pdf_url: o.pdf_url || '', retracted: !!o.retracted, preprint: !!o.preprint, publisher: clean(o.publisher)
  };
}

// ---------------------------------------------------------------- Academic papers
const oaParams = (p) => (process.env.OPENALEX_API_KEY ? { ...p, api_key: process.env.OPENALEX_API_KEY } : (CONTACT() ? { ...p, mailto: CONTACT() } : p));
function abstractFrom(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ');
}
function parseOpenAlex(results) {
  return (results || []).map((w) => {
    const loc = w.primary_location || {};
    const src = loc.source || {};
    const venue = src.display_name;
    const preprint = w.type === 'preprint' || src.type === 'repository';
    const tier = ['article', 'review', 'book', 'book-chapter'].includes(w.type) && venue && !preprint ? 'high' : 'medium';
    const oa = (w.open_access || {}).oa_url || '';
    return item('openalex', w.type === 'book' ? 'book' : 'paper', tier, w.display_name || w.title, {
      authors: (w.authorships || []).map((a) => (a.author || {}).display_name), year: w.publication_year, venue, abstract: abstractFrom(w.abstract_inverted_index),
      url: oa || loc.landing_page_url || w.doi, doi: w.doi, citations: w.cited_by_count,
      pdf_url: loc.pdf_url || (/\.pdf$/i.test(oa) ? oa : ''), retracted: w.is_retracted, preprint, publisher: src.host_organization_name
    });
  });
}
async function searchOpenAlex(q, limit, opts = {}) {
  const p = { search: q, 'per-page': Math.min(limit, 50) };
  if (opts.since) p.filter = 'from_publication_date:' + opts.since + '-01-01';
  return parseOpenAlex((await request('openalex', 'https://api.openalex.org/works', { params: oaParams(p) })).results);
}

const s2Headers = () => (process.env.S2_API_KEY ? { 'x-api-key': process.env.S2_API_KEY } : {});
function parseS2(p) {
  const venue = p.venue || '';
  const pdf = (p.openAccessPdf || {}).url || '';
  const preprint = ['arxiv', 'arxiv.org', 'biorxiv', 'medrxiv', 'ssrn'].includes(venue.toLowerCase());
  return item('semantic_scholar', 'paper', venue && !preprint ? 'high' : 'medium', p.title, {
    authors: (p.authors || []).map((a) => a.name), year: p.year, venue, abstract: p.abstract || (p.tldr || {}).text, url: pdf || p.url,
    doi: (p.externalIds || {}).DOI, citations: p.citationCount, pdf_url: pdf, preprint
  });
}
async function searchSemanticScholar(q, limit, opts = {}) {
  const params = { query: q, limit: Math.min(limit, 100), fields: 'title,abstract,year,authors,venue,citationCount,url,externalIds,openAccessPdf,tldr' };
  if (opts.since) params.year = opts.since + '-';
  const data = await request('semantic_scholar', 'https://api.semanticscholar.org/graph/v1/paper/search', { params, headers: s2Headers() });
  return (data.data || []).filter((p) => p.title).map(parseS2);
}

async function searchCrossref(q, limit, opts = {}) {
  const params = { query: q, rows: Math.min(limit, 50), select: 'DOI,title,author,issued,container-title,abstract,URL,is-referenced-by-count,type,publisher', mailto: CONTACT() };
  if (opts.since) params.filter = 'from-pub-date:' + opts.since;
  const data = await request('crossref', 'https://api.crossref.org/works', { params });
  return ((data.message || {}).items || []).map((w) => {
    const t = w.type || '';
    const parts = ((w.issued || {})['date-parts'] || [[null]])[0] || [];
    return item('crossref', t.startsWith('book') || t === 'monograph' ? 'book' : 'paper',
      ['journal-article', 'book', 'book-chapter', 'proceedings-article', 'monograph'].includes(t) ? 'high' : 'medium', w.title, {
        authors: (w.author || []).map((a) => ((a.given || '') + ' ' + (a.family || '')).trim() || a.name), year: parts[0],
        venue: (w['container-title'] || [w.publisher])[0], abstract: w.abstract, url: w.URL, doi: w.DOI, citations: w['is-referenced-by-count'],
        preprint: t === 'posted-content', publisher: w.publisher
      });
  });
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (name) => ['entry', 'author', 'PubmedArticle', 'Author', 'AbstractText', 'ArticleId', 'link'].includes(name) });
async function searchArxiv(q, limit, opts = {}) {
  const words = (String(q).match(/[A-Za-z0-9-]+/g) || []).slice(0, 6);
  const query = words.length ? words.map((w) => 'all:' + w).join(' AND ') : 'all:' + q;
  const text = await request('arxiv', 'https://export.arxiv.org/api/query', { params: { search_query: query, start: 0, max_results: Math.min(limit, 50), sortBy: 'relevance' }, as: 'text' });
  const feed = (xml.parse(text) || {}).feed || {};
  return (feed.entry || []).map((e) => {
    const id = textOf(e.id);
    return item('arxiv', 'paper', 'medium', textOf(e.title), {
      authors: (e.author || []).map((a) => textOf(a.name)), year: textOf(e.published), venue: 'arXiv preprint', abstract: textOf(e.summary),
      url: id, doi: textOf(e['arxiv:doi']), pdf_url: id.replace('/abs/', '/pdf/'), preprint: true
    });
  }).filter((it) => !opts.since || !it.year || +it.year >= +opts.since);
}

async function searchPubmed(q, limit, opts = {}) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
  const params = { db: 'pubmed', term: q + (opts.since ? ' AND ' + opts.since + ':3000[dp]' : ''), retmax: Math.min(limit, 50), retmode: 'json', sort: 'relevance', email: CONTACT() };
  const ids = (((await request('pubmed', base + 'esearch.fcgi', { params })).esearchresult) || {}).idlist || [];
  if (!ids.length) return [];
  const doc = xml.parse(await request('pubmed', base + 'efetch.fcgi', { params: { db: 'pubmed', id: ids.join(','), retmode: 'xml' }, as: 'text' }));
  return (((doc.PubmedArticleSet || {}).PubmedArticle) || []).map((a) => {
    const mc = a.MedlineCitation || {};
    const art = mc.Article || {};
    const pmid = textOf(mc.PMID);
    const doi = ((((a.PubmedData || {}).ArticleIdList || {}).ArticleId) || []).find((x) => x && x['@_IdType'] === 'doi');
    const pd = ((art.Journal || {}).JournalIssue || {}).PubDate || {};
    return item('pubmed', 'paper', 'high', textOf(art.ArticleTitle), {
      authors: (((art.AuthorList || {}).Author) || []).filter((x) => x.LastName).map((x) => ((x.ForeName ? textOf(x.ForeName) + ' ' : '') + textOf(x.LastName))),
      year: textOf(pd.Year) || textOf(pd.MedlineDate), venue: textOf((art.Journal || {}).Title), abstract: textOf(((art.Abstract || {}).AbstractText) || []),
      url: 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', doi: doi ? textOf(doi) : ''
    });
  });
}

async function searchEuropePmc(q, limit, opts = {}) {
  const query = q + (opts.since ? ' AND PUB_YEAR:[' + opts.since + ' TO 3000]' : '');
  const data = await request('europepmc', 'https://www.ebi.ac.uk/europepmc/webservices/rest/search', { params: { query, format: 'json', resultType: 'core', pageSize: Math.min(limit, 25) } });
  return (((data.resultList || {}).result) || []).map((r) => item('europepmc', 'paper', r.source === 'PPR' ? 'medium' : 'high', r.title, {
    authors: String(r.authorString || '').replace(/\.$/, '').split(/,\s*/), year: r.pubYear,
    venue: (((r.journalInfo || {}).journal) || {}).title || r.journalTitle, abstract: r.abstractText, doi: r.doi,
    url: r.doi ? 'https://doi.org/' + r.doi : 'https://europepmc.org/article/' + r.source + '/' + r.id, citations: r.citedByCount, preprint: r.source === 'PPR'
  }));
}

async function searchDoaj(q, limit) {
  const data = await request('doaj', 'https://doaj.org/api/search/articles/' + encodeURIComponent(q), { params: { pageSize: Math.min(limit, 100) } });
  return (data.results || []).map((r) => {
    const b = r.bibjson || {};
    const doi = ((b.identifier || []).find((i) => String(i.type || '').toLowerCase() === 'doi') || {}).id;
    const url = ((b.link || []).find((l) => l.url) || {}).url;
    return item('doaj', 'paper', 'high', b.title, { authors: (b.author || []).map((a) => a.name), year: b.year, venue: (b.journal || {}).title, abstract: b.abstract, url, doi });
  });
}

async function searchCore(q, limit) {
  const data = await request('core', 'https://api.core.ac.uk/v3/search/works', { params: { q, limit: Math.min(limit, 100) }, headers: { authorization: 'Bearer ' + process.env.CORE_API_KEY } });
  return (data.results || []).map((w) => item('core', 'paper', 'medium', w.title, {
    authors: (w.authors || []).map((a) => a.name), year: w.yearPublished, venue: w.publisher, abstract: w.abstract,
    url: w.downloadUrl || ((w.links || []).find((l) => l.url) || {}).url, doi: w.doi, pdf_url: w.downloadUrl, publisher: w.publisher
  }));
}

// ---------------------------------------------------------------- Books
async function searchOpenLibrary(q, limit) {
  const data = await request('openlibrary', 'https://openlibrary.org/search.json', { params: { q, limit: Math.min(limit, 50), fields: 'key,title,subtitle,author_name,first_publish_year,publisher,first_sentence,subject' } });
  return (data.docs || []).map((d) => {
    let desc = clean(d.first_sentence);
    if (d.subject) desc = (desc ? desc + ' ' : '') + 'Subjects: ' + d.subject.slice(0, 10).join(', ');
    return item('openlibrary', 'book', 'medium', (d.title || '') + (d.subtitle ? ': ' + d.subtitle : ''), { authors: d.author_name, year: d.first_publish_year, venue: (d.publisher || [''])[0], abstract: desc, url: 'https://openlibrary.org' + (d.key || '') });
  });
}
async function searchGoogleBooks(q, limit) {
  const data = await request('googlebooks', 'https://www.googleapis.com/books/v1/volumes', { params: { q, maxResults: Math.min(limit, 40), printType: 'books' } });
  return (data.items || []).map((v) => {
    const i = v.volumeInfo || {};
    return item('googlebooks', 'book', 'medium', (i.title || '') + (i.subtitle ? ': ' + i.subtitle : ''), { authors: i.authors, year: i.publishedDate, venue: i.publisher, abstract: i.description, url: i.infoLink });
  });
}

// ---------------------------------------------------------------- Reference, data and reports
async function searchWikipedia(q, limit, opts = {}) {
  const site = opts.lang === 'bn' ? 'bn' : 'en';
  const data = await request('wikipedia', 'https://' + site + '.wikipedia.org/w/api.php', { params: { action: 'query', format: 'json', generator: 'search', gsrsearch: q, gsrlimit: Math.min(limit, 5), prop: 'extracts|info', exintro: 1, explaintext: 1, exlimit: 'max', inprop: 'url', origin: '*' } });
  const pages = Object.values((data.query || {}).pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.filter((p) => p.extract).map((p) => item('wikipedia', 'reference', 'low', p.title, { authors: ['Wikipedia contributors'], venue: site === 'bn' ? 'Wikipedia (Bangla)' : 'Wikipedia', abstract: p.extract, url: p.fullurl }));
}
async function searchWorldBank(q, limit) {
  const data = await request('worldbank', 'https://search.worldbank.org/api/v2/wds', { params: { format: 'json', qterm: q, rows: Math.min(limit, 50), fl: 'display_title,docdt,abstracts,url,pdfurl,docty' } });
  return Object.entries(data.documents || {}).filter(([k, d]) => k !== 'facets' && d && typeof d === 'object').map(([, d]) => {
    let abs = d.abstracts;
    if (abs && typeof abs === 'object') abs = abs['cdata!'] || Object.values(abs).join(' ');
    return item('worldbank', 'report', 'medium', d.display_title, { authors: ['World Bank'], year: d.docdt, venue: 'World Bank ' + (d.docty || 'report'), abstract: abs, url: d.pdfurl || d.url });
  });
}

// ---------------------------------------------------------------- Islamic sources
async function searchQuran(q, limit, opts = {}) {
  const data = await request('quran', 'https://api.alquran.cloud/v1/search/' + encodeURIComponent(q) + '/all/en.sahih', { emptyOn404: true });
  if (!data || !data.data || typeof data.data !== 'object') return [];
  const out = [];
  for (const m of (data.data.matches || []).slice(0, limit)) {
    const s = m.surah || {};
    const ref = s.number + ':' + m.numberInSurah;
    let text = m.text;
    let venue = "The Qur'an, Sahih International translation";
    if (opts.lang === 'bn') {
      try {
        const bn = ((await request('quran', 'https://api.alquran.cloud/v1/ayah/' + ref + '/bn.bengali')).data || {}).text;
        if (bn) { text = bn + ' (English: ' + text + ')'; venue = "The Qur'an, Bangla translation (Muhiuddin Khan) & Sahih International"; }
      } catch (e) { /* English only */ }
    }
    out.push(item('quran', 'religious', 'high', "Qur'an " + ref + ' (Surah ' + (s.englishName || '') + ')', { venue, abstract: text, url: 'https://quran.com/' + s.number + '/' + m.numberInSurah }));
  }
  return out;
}

// ---------------------------------------------------------------- Web, news and site search (DuckDuckGo, no key)
async function ddgText(q, limit) {
  const html = await request('ddg', 'https://html.duckduckgo.com/html/', { method: 'POST', body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(), as: 'text', retries: 1,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BROWSER_UA, accept: 'text/html' } });
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<\/div>)/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = decode(m[1]);
    const u = href.match(/[?&]uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    out.push({ title: clean(m[2]), body: clean(m[3] || ''), href });
  }
  if (!out.length && /anomaly|captcha|blocked/i.test(html)) throw new Error('DuckDuckGo asked for a captcha (too many searches from this server)');
  return out;
}
async function ddgNews(q, limit) {
  const page = await request('ddg', 'https://duckduckgo.com/', { params: { q }, as: 'text', retries: 1, headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } });
  const vqd = (page.match(/vqd=["']?([\d-]+)["']?/) || [])[1];
  if (!vqd) throw new Error('DuckDuckGo news is not available right now');
  const data = await request('ddg', 'https://duckduckgo.com/news.js', { params: { l: 'wt-wt', o: 'json', noamp: 1, q, vqd, p: -1 }, retries: 1, headers: { 'user-agent': BROWSER_UA, referer: 'https://duckduckgo.com/' } });
  return (data.results || []).slice(0, limit).map((r) => ({ title: clean(r.title), body: clean(r.excerpt), href: r.url, date: r.date ? new Date(r.date * 1000).toISOString() : '', source: r.source }));
}
const TRUSTED = ['.gov', '.gov.au', '.gov.uk', '.gov.bd', '.edu', '.edu.au', '.ac.uk', '.ac.bd', '.int', '.un.org', 'who.int', 'oecd.org'];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const webTier = (u) => (TRUSTED.some((t) => hostOf(u).endsWith(t)) ? 'medium' : 'low');
async function searchWeb(q, limit) {
  return (await ddgText(q, Math.min(limit, 20))).map((r) => item('web', 'web', webTier(r.href), r.title, { venue: hostOf(r.href), abstract: r.body, url: r.href }));
}
async function searchNews(q, limit) {
  return (await ddgNews(q, Math.min(limit, 20))).map((r) => item('news', 'news', 'medium', r.title, { year: r.date, venue: r.source, abstract: r.body, url: r.href }));
}
async function searchHadith(q, limit, opts = {}) {
  const [site, venue] = opts.lang === 'bn' ? ['hadithbd.com', 'HadithBD (Bangla)'] : ['sunnah.com', 'Sunnah.com'];
  return (await ddgText('site:' + site + ' ' + q, Math.min(limit, 15))).map((r) => item('hadith', 'religious', 'medium', r.title, { venue, abstract: r.body, url: r.href }));
}
const siteSource = (key, site, type, tier, venue) => async (q, limit) =>
  (await ddgText('site:' + site + ' ' + q, Math.min(limit, 10))).map((r) => item(key, type, tier, r.title, { venue, abstract: r.body, url: r.href }));

// ---------------------------------------------------------------- Deeper research helpers
async function crossrefLookup(doi) {
  const w = ((await request('crossref', 'https://api.crossref.org/works/' + encodeURIComponent(doi).replace(/%2F/g, '/'), { params: { mailto: CONTACT() }, emptyOn404: true })) || {}).message || {};
  const retracted = (w['updated-by'] || []).some((u) => ['retraction', 'withdrawal', 'removal'].includes(String(u.type || '').toLowerCase()));
  return { retracted, publisher: w.publisher || '' };
}
async function unpaywallPdf(doi) {
  if (!CONTACT() || !doi) return '';
  const d = await request('unpaywall', 'https://api.unpaywall.org/v2/' + encodeURIComponent(doi).replace(/%2F/g, '/'), { params: { email: CONTACT() }, emptyOn404: true }) || {};
  return ((d.best_oa_location || {}).url_for_pdf) || '';
}
async function trailOpenAlex(doi, limit) {
  const w = await request('openalex', 'https://api.openalex.org/works/doi:' + doi, { params: oaParams({}), emptyOn404: true });
  if (!w || !w.id) return [];
  const wid = w.id.split('/').pop();
  const out = [];
  const refs = (w.referenced_works || []).slice(0, 50).map((r) => r.split('/').pop());
  if (refs.length) {
    const d = await request('openalex', 'https://api.openalex.org/works', { params: oaParams({ filter: 'openalex:' + refs.join('|'), sort: 'cited_by_count:desc', 'per-page': limit }) });
    out.push(...parseOpenAlex(d.results).map((it) => [it, 'reference']));
  }
  const d = await request('openalex', 'https://api.openalex.org/works', { params: oaParams({ filter: 'cites:' + wid, sort: 'cited_by_count:desc', 'per-page': limit }) });
  out.push(...parseOpenAlex(d.results).map((it) => [it, 'citing']));
  return out;
}
async function trailS2(doi, limit) {
  const out = [];
  for (const [kind, path, key] of [['reference', 'references', 'citedPaper'], ['citing', 'citations', 'citingPaper']]) {
    const d = await request('semantic_scholar', 'https://api.semanticscholar.org/graph/v1/paper/DOI:' + doi + '/' + path, { params: { fields: 'title,abstract,year,authors,venue,citationCount,url,externalIds,openAccessPdf', limit: 100 }, headers: s2Headers(), emptyOn404: true });
    const papers = (d.data || []).map((x) => x[key] || {}).filter((p) => p.title).sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));
    out.push(...papers.slice(0, limit).map((p) => [parseS2(p), kind]));
  }
  return out;
}
// Papers this DOI cites ("reference") and papers that cite it ("citing"), most cited first.
async function citationTrail(doi, limit) {
  const order = process.env.OPENALEX_API_KEY ? [trailOpenAlex, trailS2] : [trailS2, trailOpenAlex];
  let err;
  for (const fn of order) {
    try { const r = await fn(doi, limit); if (r.length) return r; } catch (e) { err = e; }
  }
  if (err) throw err;
  return [];
}

// ---------------------------------------------------------------- Registry
// mode: "questions" = searched once per sub-question, "topic" = once for the main topic,
//       "islamic" = searched with the Islamic keywords from the plan,
//       "bd" = main topic + first two sub-questions (English), "bd_bn" = same, in Bangla when Bangla mode is on.
const GROUPS = ['Academic papers', 'Books', 'Data & reports', 'Reference', 'Islamic sources', 'Web & news', 'Bangladesh sources'];
const SOURCE_TYPES = {
  openalex: { label: 'OpenAlex', group: 'Academic papers', search: searchOpenAlex, mode: 'questions', default: true, note: '250M+ journal articles, books and reports' },
  semantic_scholar: { label: 'Semantic Scholar', group: 'Academic papers', search: searchSemanticScholar, mode: 'questions', default: true, note: '200M+ papers across all fields' },
  crossref: { label: 'CrossRef', group: 'Academic papers', search: searchCrossref, mode: 'questions', default: true, note: 'Publisher records for 150M+ works' },
  doaj: { label: 'DOAJ (open-access journals)', group: 'Academic papers', search: searchDoaj, mode: 'questions', default: true, note: 'Peer-reviewed open-access journals' },
  arxiv: { label: 'arXiv (preprints)', group: 'Academic papers', search: searchArxiv, mode: 'questions', default: false, note: 'Physics, maths, computer science, economics' },
  pubmed: { label: 'PubMed (health & life sciences)', group: 'Academic papers', search: searchPubmed, mode: 'questions', default: false, note: 'Medicine and biology' },
  europepmc: { label: 'Europe PMC', group: 'Academic papers', search: searchEuropePmc, mode: 'questions', default: false, note: 'Life sciences, health and environment' },
  core: { label: 'CORE (open-access full text)', group: 'Academic papers', search: searchCore, mode: 'questions', default: true, note: 'Open-access papers from repositories', needs: 'CORE_API_KEY' },
  openlibrary: { label: 'Open Library', group: 'Books', search: searchOpenLibrary, mode: 'topic', default: true, note: 'Books' },
  googlebooks: { label: 'Google Books', group: 'Books', search: searchGoogleBooks, mode: 'questions', default: false, note: 'Books with descriptions' },
  worldbank: { label: 'World Bank reports', group: 'Data & reports', search: searchWorldBank, mode: 'questions', default: false, note: 'Development reports and data' },
  wikipedia: { label: 'Wikipedia (+ Bangla Wikipedia)', group: 'Reference', search: searchWikipedia, mode: 'topic', default: true, note: 'Background and definitions' },
  quran: { label: "Qur'an (English + Bangla translation)", group: 'Islamic sources', search: searchQuran, mode: 'islamic', default: false, note: 'Verses, Sahih International and Muhiuddin Khan' },
  hadith: { label: 'Hadith (Sunnah.com + HadithBD in Bangla mode)', group: 'Islamic sources', search: searchHadith, mode: 'islamic', default: false, note: 'Hadith collections' },
  web: { label: 'Web search (DuckDuckGo)', group: 'Web & news', search: searchWeb, mode: 'questions', default: false, note: 'Government, NGO and other web pages' },
  news: { label: 'News (DuckDuckGo)', group: 'Web & news', search: searchNews, mode: 'topic', default: false, note: 'Recent news' },
  banglajol: { label: 'BanglaJOL (Bangladesh journals)', group: 'Bangladesh sources', search: siteSource('banglajol', 'banglajol.info', 'paper', 'high', 'Bangladesh Journals Online (BanglaJOL)'), mode: 'bd', default: false, bd: true },
  bbs: { label: 'Bangladesh Bureau of Statistics', group: 'Bangladesh sources', search: siteSource('bbs', 'bbs.gov.bd', 'report', 'high', 'Bangladesh Bureau of Statistics'), mode: 'bd', default: false, bd: true },
  bangladesh_bank: { label: 'Bangladesh Bank', group: 'Bangladesh sources', search: siteSource('bangladesh_bank', 'bb.org.bd', 'report', 'high', 'Bangladesh Bank'), mode: 'bd', default: false, bd: true },
  dailystar: { label: 'The Daily Star', group: 'Bangladesh sources', search: siteSource('dailystar', 'thedailystar.net', 'news', 'medium', 'The Daily Star'), mode: 'bd', default: false, bd: true },
  prothomalo: { label: 'Prothom Alo (prothomalo.com)', group: 'Bangladesh sources', search: siteSource('prothomalo', 'prothomalo.com', 'news', 'medium', 'Prothom Alo'), mode: 'bd_bn', default: false, bd: true }
};
// Older parts were saved with the first version's source keys.
const ALIASES = { papers: 'openalex', s2: 'semantic_scholar', wiki: 'wikipedia' };
const normalizeKeys = (list) => [...new Set(String(list || '').split(',').map((k) => ALIASES[k.trim()] || k.trim()).filter((k) => SOURCE_TYPES[k]))];
const DEFAULT_SOURCES = Object.keys(SOURCE_TYPES).filter((k) => SOURCE_TYPES[k].default && !SOURCE_TYPES[k].needs).join(',');
const available = (k) => !(SOURCE_TYPES[k] && SOURCE_TYPES[k].needs && !process.env[SOURCE_TYPES[k].needs]);
const label = (k) => (k === 'citation_trail' ? 'Citation trail' : (SOURCE_TYPES[k] || {}).label || k);

module.exports = {
  SOURCE_TYPES, GROUPS, ALIASES, DEFAULT_SOURCES, normalizeKeys, available, label,
  searchOpenAlex, searchSemanticScholar, searchCrossref, searchArxiv, searchPubmed, searchEuropePmc, searchDoaj, searchCore,
  searchOpenLibrary, searchGoogleBooks, searchWikipedia, searchWorldBank, searchQuran, searchHadith, searchWeb, searchNews,
  crossrefLookup, unpaywallPdf, citationTrail, request, abstractFrom, clean, item, ddgText
};
