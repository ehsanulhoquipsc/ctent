'use strict';
// "Log in with Telegram" (free). Set TELEGRAM_BOT_TOKEN (from @BotFather) and link the bot to the site's
// domain with /setdomain. Telegram confirms the person in their app and sends back their id, name,
// @username and photo, signed with a key derived from the bot token. Telegram never shares an email.
const crypto = require('crypto');

const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const configured = () => /^\d+:[\w-]{20,}$/.test(token());
const base = (req) => (process.env.APP_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');

function authUrl(req) {
  const q = new URLSearchParams({ bot_id: token().split(':')[0], origin: base(req), return_to: base(req) + '/auth/telegram/callback', embed: '0' });
  return 'https://oauth.telegram.org/auth?' + q.toString();
}

// Telegram signs the data: hash = HMAC-SHA256(data_check_string, SHA256(bot token)).
function verify(data, maxAgeSec = 86400) {
  if (!data || typeof data !== 'object') throw new Error('Telegram didn’t send your details. Try again.');
  const fields = {};
  for (const k of ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date']) if (data[k] !== undefined && data[k] !== null && data[k] !== '') fields[k] = String(data[k]);
  const hash = String(data.hash || '');
  if (!fields.id || !fields.auth_date || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Telegram sign-in didn’t work. Try again.');
  const check = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHash('sha256').update(token()).digest();
  const expect = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expect, 'hex'), Buffer.from(hash, 'hex'))) throw new Error('That Telegram sign-in couldn’t be verified. Try again.');
  if (Math.abs(Date.now() / 1000 - Number(fields.auth_date)) > maxAgeSec) throw new Error('That Telegram sign-in is too old. Try again.');
  if (!/^\d{1,20}$/.test(fields.id)) throw new Error('Telegram sign-in didn’t work. Try again.');
  const name = [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim() || fields.username || 'Telegram user';
  return { id: fields.id, name: name.slice(0, 120), username: fields.username ? fields.username.slice(0, 64) : null };
}

// Accounts made with Telegram alone get a placeholder address that is never shown or emailed.
const PLACEHOLDER = /@telegram\.invalid$/i;
const placeholderEmail = (id) => 'tg' + id + '@telegram.invalid';
const isPlaceholder = (email) => PLACEHOLDER.test(String(email || ''));

module.exports = { configured, authUrl, verify, placeholderEmail, isPlaceholder };
