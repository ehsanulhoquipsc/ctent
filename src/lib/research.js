'use strict';
// Free research sources the agents search. Both work without a key.
//   OpenAlex – 250M+ scholarly works with abstracts (https://openalex.org). OPENALEX_API_KEY raises the free daily budget.
//   Wikipedia – background and context.
const UA = 'CTENT-research-agent/1.0 (' + (process.env.CONTACT_EMAIL || 'https://github.com/ehsanulhoquipsc/ctent') + ')';

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error('Search service returned ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

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
      abstract: abstractFrom(w.abstract_inverted_index).slice(0, 1800), key: doi || w.id
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
    abstract: p.extract.slice(0, 1800), key: 'wiki:' + p.title
  }));
}

const SOURCE_TYPES = {
  papers: { label: 'Academic papers', note: 'OpenAlex — journal articles, books, reports' },
  wiki: { label: 'Background (Wikipedia)', note: 'Context and definitions' }
};

module.exports = { searchPapers, searchWiki, abstractFrom, SOURCE_TYPES };
