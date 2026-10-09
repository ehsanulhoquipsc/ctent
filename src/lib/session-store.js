'use strict';
const session = require('express-session');
const db = require('../db');

// Sessions live in the database so sign-ins survive restarts on the server.
class KnexStore extends session.Store {
  constructor(ttlMs) { super(); this.ttl = ttlMs || 1000 * 60 * 60 * 12; this.lastSweep = 0; }
  expiry(sess) { const c = sess && sess.cookie; return c && c.expires ? new Date(c.expires).getTime() : Date.now() + this.ttl; }
  get(sid, cb) {
    db('sessions').where({ sid }).first().then((row) => {
      if (!row || Number(row.expires) < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    }).catch(cb);
  }
  set(sid, sess, cb) {
    const row = { sid, sess: JSON.stringify(sess), expires: this.expiry(sess) };
    db('sessions').insert(row).onConflict('sid').merge().then(() => { this.sweep(); cb && cb(null); }).catch((e) => cb && cb(e));
  }
  touch(sid, sess, cb) {
    db('sessions').where({ sid }).update({ expires: this.expiry(sess) }).then(() => cb && cb(null)).catch((e) => cb && cb(e));
  }
  destroy(sid, cb) { db('sessions').where({ sid }).del().then(() => cb && cb(null)).catch((e) => cb && cb(e)); }
  sweep() {
    if (Date.now() - this.lastSweep < 60 * 60 * 1000) return;
    this.lastSweep = Date.now();
    db('sessions').where('expires', '<', Date.now()).del().catch(() => {});
  }
}

module.exports = KnexStore;
