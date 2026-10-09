// Signs in as each demo account and visits every internal link it can reach.
// Usage: node scripts/crawl.js http://localhost:3000
const base = process.argv[2] || 'http://localhost:3000';
async function session() {
  let cookie = '';
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie } });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.startsWith('ctent.sid=')) cookie = kv; }
    return r;
  };
  return req;
}
(async () => {
  const anon = await session();
  const login = await (await anon('/login')).text();
  const ids = [...login.matchAll(/name="id" value="(\d+)"/g)].map((m) => m[1]);
  const names = [...login.matchAll(/<button type="submit" style="width:100%"><span>([^<]+)<\/span><span class="mono"[^>]*>(\w+)/g)].map((m) => m[1] + ' (' + m[2] + ')');
  let bad = 0, total = 0;
  for (let i = 0; i < ids.length; i++) {
    const req = await session();
    const page = await (await req('/login')).text();
    const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
    const r = await req('/login/demo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + csrf + '&id=' + ids[i] });
    if (r.status !== 302) { console.log('login failed', names[i]); bad++; continue; }
    const seen = new Set(); const queue = ['/']; const errors = [];
    while (queue.length && seen.size < 400) {
      const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
      const res = await req(p);
      total++;
      if (res.status >= 300 && res.status < 400) { const loc = res.headers.get('location'); if (loc && loc.startsWith('/') && !seen.has(loc)) queue.push(loc); continue; }
      const ct = res.headers.get('content-type') || '';
      if (res.status !== 200 && !(res.status === 403)) errors.push(res.status + ' ' + p);
      if (res.status === 403) errors.push('403 ' + p);
      if (!ct.includes('text/html')) continue;
      const html = await res.text();
      for (const m of html.matchAll(/href="(\/[^"#]*)/g)) {
        let l = m[1].replace(/&amp;/g, '&');
        if (l.startsWith('/static') || l.includes('/files/') && !l.endsWith('/files') && !l.includes('?folder')) { if (l.includes('/files/') && !seen.has(l)) { seen.add(l); total++; const fr = await req(l); if (fr.status !== 200) errors.push(fr.status + ' ' + l); } continue; }
        if (l === '/logout') continue;
        if (!seen.has(l)) queue.push(l);
      }
    }
    console.log(names[i].padEnd(32), 'pages:', String(seen.size).padStart(3), errors.length ? 'PROBLEMS: ' + errors.join(', ') : 'ok');
    bad += errors.filter((e) => !e.startsWith('403')).length;
  }
  console.log('total requests', total, 'non-403 problems', bad);
})();
