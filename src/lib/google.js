'use strict';
// "Continue with Google" — OpenID Connect authorization-code flow, with no extra packages.
// Free: Google charges nothing for sign-in with the basic openid/email/profile scopes.
const crypto = require('crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// The address Google sends people back to. APP_URL (e.g. https://ctent.doctren.com) wins, so the
// same callback works behind Render's proxy; otherwise it comes from the request.
function redirectUri(req) {
  const base = (process.env.APP_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  return base + '/auth/google/callback';
}

function authUrl(req, state) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(req), response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account', access_type: 'online', include_granted_scopes: 'true'
  });
  return AUTH + '?' + q.toString();
}

const newState = () => crypto.randomBytes(24).toString('hex');

function decodeJwt(token) {
  const part = String(token || '').split('.')[1];
  if (!part) throw new Error('No ID token from Google.');
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

// Swap the one-time code for the person's verified Google identity. The ID token comes straight
// from Google's token endpoint over TLS, so its claims are trusted after checking audience, issuer
// and expiry (OpenID Connect Core §3.1.3.7).
async function exchange(req, code) {
  const r = await fetch(TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }).toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id_token) throw new Error(data.error_description || data.error || 'Google did not accept the sign-in.');
  const c = decodeJwt(data.id_token);
  if (c.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('This sign-in was meant for another app.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new Error('This sign-in did not come from Google.');
  if (!c.exp || c.exp * 1000 < Date.now() - 60000) throw new Error('This sign-in has expired. Try again.');
  if (!c.email || c.email_verified === false || c.email_verified === 'false') throw new Error('Google hasn’t verified this account’s email address.');
  return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: c.name || String(c.email).split('@')[0] };
}

module.exports = { configured, authUrl, newState, exchange, redirectUri };
