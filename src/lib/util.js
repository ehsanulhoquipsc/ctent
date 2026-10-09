'use strict';

const now = () => new Date().toISOString();

// Timestamps come back as Date (Postgres), ISO strings, or 'YYYY-MM-DD HH:MM:SS' (SQLite defaults).
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

const TZ = process.env.APP_TIMEZONE || 'Australia/Sydney';

function fmtDate(v, opts) {
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : toDate(v);
  if (!d || isNaN(d)) return '';
  const o = opts || { day: 'numeric', month: 'short' };
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return d.toLocaleDateString('en-AU', o);
  return d.toLocaleDateString('en-AU', { ...o, timeZone: TZ });
}
function fmtDateTime(v) {
  const d = toDate(v);
  if (!d || isNaN(d)) return '';
  return d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ });
}
function fmtTime(v) {
  const d = toDate(v);
  if (!d || isNaN(d)) return '';
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}
function ago(v) {
  const d = toDate(v);
  if (!d || isNaN(d)) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return fmtDate(d);
}
function todayStr(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return d.toISOString().slice(0, 10);
}
function isOverdue(due, status) {
  return !!due && status !== 'done' && String(due) < todayStr(0);
}

function initials(name) {
  const parts = String(name || '?').replace(/^(Dr\.?|Prof\.?)\s+/i, '').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const COLORS = {
  burgundy: ['#8E2433', '#F7E9EB'], teal: ['#0F766E', '#E3F4F1'], indigo: ['#3B4BA8', '#EAEDFA'],
  amber: ['#9A4708', '#FDF1E2'], violet: ['#6B3FA0', '#F1ECF7'], green: ['#256B42', '#E7F3EC'], red: ['#B42318', '#FDECEA'], grey: ['#5C5A57', '#F0EEEB']
};
const COLOR_NAMES = Object.keys(COLORS).filter((c) => c !== 'grey' && c !== 'red');
function color(name) { return COLORS[name] || COLORS.grey; }

// Detect the video platform from a pasted meeting link.
function detectPlatform(link) {
  const l = String(link || '').toLowerCase();
  if (l.includes('zoom.us')) return 'Zoom';
  if (l.includes('meet.google.com')) return 'Google Meet';
  if (l.includes('teams.microsoft.com') || l.includes('teams.live.com')) return 'Microsoft Teams';
  if (l.includes('webex.com')) return 'Webex';
  if (l.includes('whereby.com')) return 'Whereby';
  if (l.includes('jit.si')) return 'Jitsi';
  return l ? 'Link' : '';
}
function safeUrl(link) {
  const s = String(link || '').trim();
  if (!s) return '';
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch (e) { return ''; }
}

// Score how well a person's expertise matches the skills a part needs (0-100).
function matchScore(skillsCsv, expertise) {
  const needed = String(skillsCsv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!needed.length) return 0;
  let total = 0;
  for (const n of needed) {
    let best = 0;
    for (const e of expertise) {
      const name = e.name.toLowerCase();
      if (name === n || name.includes(n) || n.includes(name)) best = Math.max(best, e.level);
      else if (n.split(/\s+/).some((w) => w.length > 3 && name.includes(w))) best = Math.max(best, e.level - 1);
    }
    total += best;
  }
  return Math.round((total / (needed.length * 5)) * 100);
}

const STATUS = {
  todo: ['To do', 'grey'], doing: ['In progress', 'indigo'], review: ['In review', 'amber'], done: ['Done', 'green'],
  in_review: ['In review', 'amber'], changes: ['Changes requested', 'red'], approved: ['Approved', 'green'],
  planning: ['Planning', 'indigo'], active: ['Active', 'green'], archived: ['Archived', 'grey'],
  open: ['Needs owner', 'amber'], pending: ['Pending', 'amber']
};
function status(key) { const s = STATUS[key] || [key, 'grey']; return { label: s[0], c: color(s[1]) }; }

function humanSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Avatar circle in the person's colour (returns safe HTML).
function avatar(user, size, link) {
  if (!user) return '<span class="av ' + (size || '') + '" style="background:var(--line-2);color:var(--muted)">?</span>';
  const c = color(user.color || 'grey');
  const tag = link ? 'a' : 'span';
  const href = link ? ' href="/people/' + Number(user.id || user.user_id) + '"' : '';
  return '<' + tag + href + ' class="av ' + (size || '') + '" title="' + esc(user.name) + '" style="background:' + c[1] + ';color:' + c[0] + '">' + esc(initials(user.name)) + '</' + tag + '>';
}
function tag(key) { const s = status(key); return '<span class="tag dotted" style="background:' + s.c[1] + ';color:' + s.c[0] + '">' + esc(s.label) + '</span>'; }
function roleTag(role) {
  const m = { admin: ['ADMIN', 'burgundy'], leader: ['LEADER', 'burgundy'], member: ['MEMBER', 'indigo'], guest: ['GUEST', 'violet'] }[role] || [String(role).toUpperCase(), 'grey'];
  const c = color(m[1]);
  return '<span class="tag" style="font:600 10px var(--mono);letter-spacing:.05em;background:' + c[1] + ';color:' + c[0] + '">' + m[0] + '</span>';
}

const ICONS = {
  home: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z',
  board: 'M4.5 3h4A1.5 1.5 0 0 1 10 4.5v15A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3zM15.5 3h4A1.5 1.5 0 0 1 21 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 12.5v-8A1.5 1.5 0 0 1 15.5 3z',
  video: 'm22 8-6 4 6 4V8ZM4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  search: 'M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM21 21l-4.3-4.3',
  plus: 'M5 12h14M12 5v14',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M3 6h18M3 12h18M3 18h18',
  file: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2zM14 2v6h6',
  check: 'M20 6 9 17l-5-5',
  send: 'm22 2-7 20-4-9-9-4ZM22 2 11 13'
};
function icon(name, size) {
  const n = size || 18;
  return '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (ICONS[name] || '') + '"></path></svg>';
}

module.exports = { icon, esc, avatar, tag, roleTag, now, toDate, fmtDate, fmtDateTime, fmtTime, ago, todayStr, isOverdue, initials, color, COLOR_NAMES, detectPlatform, safeUrl, matchScore, status, humanSize, TZ };
