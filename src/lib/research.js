'use strict';
// Free research sources the agents search. All work without a key.
//   OpenAlex – 250M+ scholarly works with abstracts (https://openalex.org). OPENALEX_API_KEY raises the free daily budget.
//   Semantic Scholar – 200M+ papers (https://www.semanticscholar.org/product/api). S2_API_KEY gives a private rate limit.
//   Europe PMC – life sciences, health and environment literature (https://europepmc.org/RestfulWebService).
//   arXiv – preprints in physics, maths, computer science, economics (https://info.arxiv.org/help/api).
//   Wikipedia – background and context.
const UA = 'CTENT-research-agent/1.0 (' + (process.env.CONTACT_EMAIL || 'https://github.com/ehsanulhoquipsc/ctent') + ')';

async function fetchOk(url, headers, as) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...(headers || {}) }, signal: ctl.signal });
    if (!res.ok) throw new Error('Search service returned ' + res.status + (res.status === 429 ? ' (busy — free limit reached)' : ''));
    return as === 'text' ? await res.text() : await res.json();
  } catch (e) { if (e.name === 'AbortError') throw new Error('Search service timed out'); throw e; } finally { clearTimeout(timer); }
}
const getJson = (url, headers) => fetchOk(url, { accept: 'application/json', ...(headers || {}) });
const keyOf = (doi, title) => (doi ? 'doi:' + String(doi).toLowerCase() : 't:' + String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
const names = (list, max) => { const a = list.filter(Boolean); return a.slice(0, max || 6).join(', ') + (a.length > (max || 6) ? ' et al.' : ''); };

function abstractFrom(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ');
}

async function searchPapers(query, { since, limit } = {}) {
  const params = new URLSearchParams({
    search: query, 'per-page': String(Math.min(25, limit || 10)),
    select: 'id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,abstract_inverted_index'
  });
  const filters = ['has_abstract:true'];
  if (since) filters.push('from_publication_date:' + since + '-01-01');
  params.set('filter', filters.join(','));
  if (process.env.OPENALEX_API_KEY) params.set('api_key', process.env.OPENALEX_API_KEY);
  if (process.env.CONTACT_EMAIL) params.set('mailto', process.env.CONTACT_EMAIL);
  const data = await getJson('https://api.openalex.org/works?' + params.toString());
  return (data.results || []).map((w) => {
    const loc = w.primary_location || {};
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : null;
    return {
      kind: 'paper', title: w.display_name || 'Untitled', year: w.publication_year || null,
      authors: (w.authorships || []).slice(0, 6).map((a) => (a.author && a.author.display_name) || '').filter(Boolean).join(', ') + ((w.authorships || []).length > 6 ? ' et al.' : ''),
      venue: (loc.source && loc.source.display_name) || null,
      url: doi ? 'https://doi.org/' + doi : (loc.landing_page_url || w.id), doi, cited_by: w.cited_by_count || 0,
      abstract: abstractFrom(w.abstract_inverted_index).slice(0, 1800), key: keyOf(doi, w.display_name)
    };
  });
}

async function searchWiki(query, { limit } = {}) {
  const s = await getJson('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit || 2), format: 'json', origin: '*' }));
  const titles = ((s.query && s.query.search) || []).map((r) => r.title);
  if (!titles.length) return [];
  const e = await getJson('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ action: 'query', prop: 'extracts|info', exintro: '1', explaintext: '1', inprop: 'url', titles: titles.join('|'), format: 'json', origin: '*' }));
  return Object.values((e.query && e.query.pages) || {}).filter((p) => p.extract).map((p) => ({
    kind: 'wiki', title: p.title + ' (Wikipedia)', year: null, authors: 'Wikipedia contributors', venue: 'Wikipedia',
    url: p.fullurl || 'https://en.wikipedia.org/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_')), doi: null, cited_by: 0,
    abstract: p.extract.slice(0, 1800), key: 'wiki:' + p.title.toLowerCase()
  }));
}

async function searchSemanticScholar(query, { since, limit } = {}) {
  const params = new URLSearchParams({ query, limit: String(Math.min(20, limit || 10)), fields: 'title,abstract,year,authors,venue,externalIds,citationCount,url' });
  if (since) params.set('year', since + '-');
  const headers = process.env.S2_API_KEY ? { 'x-api-key': process.env.S2_API_KEY } : {};
  const data = await getJson('https://api.semanticscholar.org/graph/v1/paper/search?' + params.toString(), headers);
  return (data.data || []).filter((p) => p.abstract).map((p) => {
    const doi = (p.externalIds && p.externalIds.DOI) || null;
    return { kind: 'paper', title: p.title || 'Untitled', year: p.year || null, authors: names((p.authors || []).map((a) => a.name)), venue: p.venue || null,
      url: doi ? 'https://doi.org/' + doi : p.url, doi, cited_by: p.citationCount || 0, abstract: String(p.abstract).slice(0, 1800), key: keyOf(doi, p.title) };
  });
}

async function searchEuropePmc(query, { since, limit } = {}) {
  const q = query + (since ? ' AND PUB_YEAR:[' + since + ' TO 3000]' : '');
  const data = await getJson('https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + new URLSearchParams({ query: q, format: 'json', resultType: 'core', pageSize: String(Math.min(25, limit || 10)) }));
  return (((data.resultList || {}).result) || []).filter((r) => r.abstractText).map((r) => ({
    kind: 'paper', title: r.title || 'Untitled', year: parseInt(r.pubYear, 10) || null, authors: r.authorString ? r.authorString.replace(/\.$/, '') : null,
    venue: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || r.journalTitle || null, doi: r.doi || null,
    url: r.doi ? 'https://doi.org/' + r.doi : 'https://europepmc.org/article/' + r.source + '/' + r.id, cited_by: r.citedByCount || 0,
    abstract: String(r.abstractText).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1800), key: keyOf(r.doi, r.title)
  }));
}

async function searchArxiv(query, { since, limit } = {}) {
  const xml = await fetchOk('https://export.arxiv.org/api/query?' + new URLSearchParams({ search_query: 'all:' + query, start: '0', max_results: String(Math.min(15, limit || 8)), sortBy: 'relevance' }), { accept: 'application/atom+xml' }, 'text');
  const tag = (block, t) => { const m = block.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  const decode = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return (xml.split('<entry>').slice(1)).map((e) => {
    const year = parseInt(tag(e, 'published').slice(0, 4), 10) || null;
    const doi = tag(e, 'arxiv:doi') || null;
    const id = tag(e, 'id');
    const title = decode(tag(e, 'title'));
    return { kind: 'paper', title, year, authors: names([...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => decode(m[1]))), venue: 'arXiv preprint', doi,
      url: doi ? 'https://doi.org/' + doi : id, cited_by: 0, abstract: decode(tag(e, 'summary')).slice(0, 1800), key: keyOf(doi, title) };
  }).filter((p) => p.abstract && (!since || !p.year || p.year >= since));
}

const SOURCE_TYPES = {
  papers: { label: 'Academic papers', note: 'OpenAlex — 250M+ journal articles, books and reports', search: searchPapers },
  s2: { label: 'Semantic Scholar', note: '200M+ papers across all fields', search: searchSemanticScholar },
  europepmc: { label: 'Health & life sciences', note: 'Europe PMC — medicine, biology, environment', search: searchEuropePmc },
  arxiv: { label: 'Preprints (arXiv)', note: 'Physics, maths, computer science, economics', search: searchArxiv },
  wiki: { label: 'Background (Wikipedia)', note: 'Context and definitions' }
};

module.exports = { searchPapers, searchSemanticScholar, searchEuropePmc, searchArxiv, searchWiki, abstractFrom, SOURCE_TYPES };
