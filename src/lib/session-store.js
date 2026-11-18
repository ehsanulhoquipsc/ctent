'use strict';
const session = require('express-session');
const db = require('../db');

// Sessions live in the database so sign-ins survive restarts on the server.
class KnexStore extends session.Store {
  constructor(ttlMs) { super(); this.ttl = ttlMs || 1000 * 60 * 60 * 12; this.lastSweep = 0; this.touched = new Map(); }
  expiry(sess) { const c = sess && sess.cookie; return c && c.expires ? new Date(c.expires).getTime() : Date.now() + this.ttl; }
  get(sid, cb) {
    db('sessions').where({ sid }).first().then((row) => {
      if (!row || Number(row.expires) < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    }).catch(cb);
  }
  set(sid, sess, cb) {
    const row = { sid, sess: JSON.stringify(sess), expires: this.expiry(sess) };
    this.touched.set(sid, Date.now());
    db('sessions').insert(row).onConflict('sid').merge().then(() => { this.sweep(); cb && cb(null); }).catch((e) => cb && cb(e));
  }
  // Keeping a sign-in alive doesn't need a database write on every click: at most one every 10 minutes.
  touch(sid, sess, cb) {
    const last = this.touched.get(sid) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return cb && cb(null);
    if (this.touched.size > 5000) this.touched.clear();
    this.touched.set(sid, Date.now());
    db('sessions').where({ sid }).update({ expires: this.expiry(sess) }).then(() => cb && cb(null)).catch((e) => cb && cb(e));
  }
  destroy(sid, cb) { this.touched.delete(sid); db('sessions').where({ sid }).del().then(() => cb && cb(null)).catch((e) => cb && cb(e)); }
  sweep() {
    if (Date.now() - this.lastSweep < 60 * 60 * 1000) return;
    this.lastSweep = Date.now();
    db('sessions').where('expires', '<', Date.now()).del().catch(() => {});
  }
}

module.exports = KnexStore;
