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
        frameAncestors: ["'self'"]
      }
    }
  }));
  app.use(compression());
  if (process.env.NODE_ENV !== 'test') app.use(morgan(prod ? 'combined' : 'dev'));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: prod ? '7d' : 0 }));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'img', 'favicon.png')));
  app.get('/healthz', async (req, res) => { await db.raw('select 1'); res.json({ ok: true }); });

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
  app.use(auth.csrf);

  // Values every page can use
  app.use(async (req, res, next) => {
    res.locals.u = util;
    res.locals.assetV = ASSET_V;
    res.locals.csrf = auth.csrfToken(req);
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    res.locals.unread = 0;
    res.locals.actionCount = 0;
    res.locals.pinned = [];
    if (req.user) {
      const r = await db('notifications').where({ user_id: req.user.id }).whereNull('read_at').count({ n: '*' }).first();
      res.locals.unread = Number(r.n);
      res.locals.isAdmin = req.user.platform_role === 'admin';
      res.locals.isMemberOnly = auth.RANK[req.user.platform_role] < auth.RANK.leader;
      if (!res.locals.isMemberOnly || (await db('topic_members').where({ user_id: req.user.id, role: 'leader' }).first())) {
        res.locals.actionCount = (await actionItems(req.user)).length;
        res.locals.showActions = true;
      }
      const ids = await auth.myTopicIds(req.user);
      res.locals.pinned = ids.length ? await db('topics').whereIn('id', ids).whereNot('status', 'archived').orderBy('id', 'desc').limit(4).select('id', 'code', 'title', 'color') : [];
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

module.exports = { createApp };
