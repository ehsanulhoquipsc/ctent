'use strict';
// Changes on every deploy so browsers fetch fresh CSS/JS despite long cache times.
const ASSET_V = (process.env.RENDER_GIT_COMMIT || '').slice(0, 8) || Date.now().toString(36);
const path = require('path');
const i18n = require('./lib/i18n');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const db = require('./db');
const KnexStore = require('./lib/session-store');
const auth = require('./lib/auth');
const util = require('./lib/util');
const { actionItems } = require('./lib/actions');

// The numbers every page's menu shows (Inbox count, pinned projects). They're asked for in parallel and
// kept for a few seconds per person, so clicking around doesn't repeat ~15 database trips on every page.
// Any change anyone makes (a POST) clears them, so counts are never behind your own actions.
const MENU_TTL = process.env.NODE_ENV === 'test' && !process.env.MENU_CACHE ? 0 : 20 * 1000;
const menuCache = new Map();
function clearMenus() { menuCache.clear(); }
async function menuData(user) {
  const hit = menuCache.get(user.id);
  if (hit && Date.now() - hit.at < MENU_TTL && hit.role === user.platform_role) return hit.data;
  const memberOnly = auth.RANK[user.platform_role] < auth.RANK.leader;
  const [unreadRow, leads, ids, roleRows] = await Promise.all([
    db('notifications').where({ user_id: user.id }).whereNull('read_at').count({ n: '*' }).first(),
    memberOnly ? db('topic_members').where({ user_id: user.id, role: 'leader' }).first() : true,
    auth.myTopicIds(user),
    db('topic_members').where({ user_id: user.id }).select('topic_id', 'role')
  ]);
  const showActions = !!leads;
  const [actions, pinnedRows] = await Promise.all([
    showActions ? actionItems(user) : [],
    ids.length ? db('topics').whereIn('id', ids).whereNotIn('status', ['archived', 'completed']).orderBy('id', 'desc').limit(4).select('*') : []
  ]);
  let pinned = [];
  if (pinnedRows.length) {
    const roles = Object.fromEntries(roleRows.map((x) => [x.topic_id, x.role]));
    const js = await require('./lib/journey').journeyMany(pinnedRows, roles);
    pinned = pinnedRows.map((t) => ({ id: t.id, code: t.code, title: t.title, color: t.color, j: js[t.id] }));
  }
  const unread = Number(unreadRow.n);
  const data = { unread, actionCount: actions.length, showActions, inboxCount: actions.length + unread, pinned };
  if (menuCache.size > 500) menuCache.clear();
  menuCache.set(user.id, { at: Date.now(), role: user.platform_role, data });
  return data;
}

function createApp() {
  const app = express();
  const prod = process.env.NODE_ENV === 'production';
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (prod) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        frameAncestors: ["'self'"]
      }
    }
  }));
  app.use(compression());
  if (process.env.NODE_ENV !== 'test') app.use(morgan(prod ? 'combined' : 'dev'));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: prod ? '7d' : 0 }));
  // Installable app (PWA): the manifest and a service worker at the site root so it controls every page.
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
      id: '/', name: 'CTENT — Conducting from Interior', short_name: 'CTENT',
      description: 'Your research group’s workspace: projects, AI research agents, papers and team chat.',
      start_url: '/?source=app', scope: '/', display: 'standalone', orientation: 'any',
      background_color: '#F7F6F4', theme_color: '#8E2433',
      icons: [
        { src: '/static/img/icon-192.png?v=' + ASSET_V, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/static/img/icon-512.png?v=' + ASSET_V, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/static/img/icon-maskable-512.png?v=' + ASSET_V, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ],
      shortcuts: [
        { name: 'Inbox', url: '/inbox', icons: [{ src: '/static/img/icon-192.png', sizes: '192x192' }] },
        { name: 'Projects', url: '/topics', icons: [{ src: '/static/img/icon-192.png', sizes: '192x192' }] }
      ]
    }));
  });
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache').set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, '..', 'public', 'pwa', 'sw.js'));
  });
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'img', 'favicon.png')));
  app.get('/healthz', async (req, res) => { await db.raw('select 1'); res.json({ ok: true, version: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7) }); });

  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    name: 'ctent.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    store: new KnexStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 1000 * 60 * 60 * 12 }
  }));
  app.use(auth.loadUser);
  app.use((req, res, next) => { if (req.method !== 'GET' && req.method !== 'HEAD') { clearMenus(); res.on('finish', clearMenus); } next(); });
  app.use(auth.csrf);
  // A fresh form token for pages left open while the session changed (signing in again in another tab, for example).
  app.get('/csrf.json', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ token: auth.csrfToken(req), signedIn: !!req.user }); });

  // Values every page can use
  app.use(async (req, res, next) => {
    res.locals.u = util;
    res.locals.assetV = ASSET_V;
    res.locals.csrf = auth.csrfToken(req);
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) req.session.flash = null; // only touch the session when there was a message to clear
    res.locals.unread = 0;
    res.locals.actionCount = 0;
    res.locals.pinned = [];
    res.locals.inboxCount = 0;
    if (req.user) {
      res.locals.isAdmin = req.user.platform_role === 'admin';
      res.locals.isMemberOnly = auth.RANK[req.user.platform_role] < auth.RANK.leader;
      Object.assign(res.locals, await menuData(req.user));
    }
    next();
  });
  app.use((req, res, next) => {
    req.flash = (type, text) => { req.session.flash = { type, text }; };
    next();
  });

  // Interface language: chosen from the globe menu, remembered in a cookie for a year.
  app.get('/lang/:code', (req, res) => {
    const code = i18n.LANGS[req.params.code] ? req.params.code : 'en';
    res.cookie('lang', code, { maxAge: 365 * 86400000, sameSite: 'lax', httpOnly: false, secure: prod });
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/';
    res.redirect(next);
  });
  app.use((req, res, next) => {
    const lang = i18n.pick(req);
    res.locals.lang = lang;
    res.locals.LANGS = i18n.LANGS;
    res.locals.here = req.originalUrl;
    if (lang !== 'en') {
      const render = res.render.bind(res);
      res.render = (view, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        render(view, opts || {}, (err, html) => {
          if (err) return cb ? cb(err) : next(err);
          html = i18n.translateHtml(html, lang);
          return cb ? cb(null, html) : res.send(html);
        });
      };
      const json = res.json.bind(res);
      res.json = (body) => { if (body && typeof body.error === 'string') body.error = i18n.t(body.error, lang); return json(body); };
    }
    next();
  });

  app.use(require('./routes/auth'));
  app.use(auth.requireUser);
  app.use(require('./routes/dashboard'));
  app.use(require('./routes/finish'));
  app.use(require('./routes/publish'));
  app.use(require('./routes/agents'));
  app.use(require('./routes/paper'));
  app.use(require('./routes/topics'));
  app.use(require('./routes/tasks'));
  app.use(require('./routes/work'));
  app.use(require('./routes/messages'));
  app.use(require('./routes/review'));
  app.use(require('./routes/people'));
  app.use(require('./routes/admin'));

  app.use((req, res) => auth.notFound(res));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).render('pages/error', { title: 'File too large', code: 413, message: 'Files can be up to 10 MB in this demo.' });
    res.status(500).render('pages/error', { title: 'Something went wrong', code: 500, message: 'Your work is saved. Try again in a moment.' });
  });
  return app;
}

module.exports = { createApp, clearMenus };
