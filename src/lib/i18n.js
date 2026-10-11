'use strict';
// Interface translation. Pages are written in English; for another language the finished HTML is
// translated phrase by phrase from a dictionary (src/locales/<code>.js). User content (titles, messages,
// file names, anything typed) is left as written unless it happens to be exactly a UI phrase.

const LANGS = {
  en: { name: 'English', native: 'English', dir: 'ltr' },
  bn: { name: 'Bengali', native: 'বাংলা', dir: 'ltr' }
};
const dicts = {};
function load(code) {
  if (code === 'en' || !LANGS[code]) return null;
  if (!dicts[code]) dicts[code] = require('../locales/' + code);
  return dicts[code];
}

const decode = (s) => s.replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');

// Tags and the blocks we never touch (scripts, styles, user-typed text areas, code).
const SPLIT = /(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<textarea[\s\S]*?<\/textarea>|<pre[\s\S]*?<\/pre>|<!--[\s\S]*?-->|<[^>]+>)/i;
const ATTRS = /\s(placeholder|aria-label|title|data-confirm|data-confirm-btn|alt)="([^"]*)"/g;
// Elements whose text is user content and should not be translated even if it matches.
const SKIP_OPEN = /^<(?:[^>]*\sdata-i18n-skip|[^>]*\sclass="[^"]*\b(?:user-text)\b)/i;

function phrase(text, d, attr) {
  const t = text.trim();
  if (!t || !/[A-Za-z]/.test(t)) return null;
  if (Object.prototype.hasOwnProperty.call(d.phrases, t)) return d.phrases[t];
  // Compound labels: "Senior lecturer · 2 open tasks", "Board · CT-0142 · CTENT"
  for (const sep of [' · ']) {
    if (t.includes(sep)) {
      const ps = t.split(sep), tr = ps.map((x) => phrase(x, d, attr));
      if (tr.some((x) => x != null)) return ps.map((x, i) => (tr[i] == null ? x : tr[i])).join(sep);
    }
  }
  const sub = (x) => { const r = phrase(x, d, attr); return r == null ? x : r; };
  for (const [re, fn] of attr ? d.patterns.concat(d.attrPatterns || []) : d.patterns) { const m = t.match(re); if (m) return typeof fn === 'function' ? fn(m, sub) : fn; }
  if (t.startsWith('· ')) { const r = phrase(t.slice(2), d, attr); if (r != null) return '· ' + r; }
  if (t.startsWith('+ ')) { const r = phrase(t.slice(2), d, attr); if (r != null) return '+ ' + r; }
  if (t.startsWith('/ ')) { const r = phrase(t.slice(2), d, attr); if (r != null) return '/ ' + r; }
  if (t.startsWith('← ')) { const r = phrase(t.slice(2), d, attr); if (r != null) return '← ' + r; }
  return null;
}
function swap(raw, d, attr) {
  const plain = decode(raw);
  const out = phrase(plain, d, attr);
  if (out == null) return raw;
  const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
  return lead + encode(out) + trail;
}

function translateHtml(html, code) {
  const d = load(code);
  if (!d) return html;
  const parts = html.split(SPLIT);
  let skipDepth = 0, skipTag = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (i % 2 === 1) {
      if (/^<(script|style|textarea|pre|!--)/i.test(p)) continue;
      // Track elements marked as user content
      if (skipDepth) {
        if (new RegExp('^<' + skipTag + '[\\s>]', 'i').test(p) && !/\/>$/.test(p)) skipDepth++;
        else if (new RegExp('^</' + skipTag + '\\s*>', 'i').test(p)) skipDepth--;
        continue;
      }
      if (SKIP_OPEN.test(p) && !/\/>$/.test(p)) { skipTag = p.match(/^<([a-z0-9]+)/i)[1]; skipDepth = 1; continue; }
      if (p[1] !== '/') parts[i] = p.replace(ATTRS, (all, name, val) => { const s = swap(val, d, true); return s === val ? all : ' ' + name + '="' + s + '"'; });
      continue;
    }
    if (skipDepth) continue;
    parts[i] = swap(p, d);
  }
  let out = parts.join('');
  out = out.replace(/<html lang="en"/, '<html lang="' + code + '"');
  return out;
}

// Translate a single string (flash messages, JSON errors).
function t(text, code) { const d = load(code); if (!d || !text) return text; const r = phrase(String(text), d, true); return r == null ? text : r; }

function pick(req) {
  const c = (req.headers.cookie || '').match(/(?:^|;\s*)lang=([a-z]{2})/);
  if (c && LANGS[c[1]]) return c[1];
  return 'en';
}

module.exports = { LANGS, translateHtml, t, pick, decode, SPLIT, ATTRS };
