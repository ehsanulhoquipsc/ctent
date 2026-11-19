// Telegram returns the signed sign-in details after "#tgAuthResult=" in the address. Only the browser
// can read that part, so pass it to the server (which checks Telegram's signature) in a form post.
(function () {
  'use strict';
  var form = document.querySelector('[data-tg-form]');
  if (!form) return;
  var m = /[#&]tgAuthResult=([^&]+)/.exec(location.hash || '');
  if (history.replaceState) history.replaceState(null, '', location.pathname);
  if (!m) {
    document.querySelector('[data-tg-title]').textContent = 'Telegram sign-in was cancelled';
    document.querySelector('[data-tg-text]').textContent = 'Nothing was changed. You can try again or choose another way to sign in.';
    document.querySelector('[data-tg-back]').hidden = false;
    return;
  }
  var raw = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
  while (raw.length % 4) raw += '=';
  var json = 'null';
  try { json = decodeURIComponent(Array.prototype.map.call(atob(raw), function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')); } catch (e) { json = 'null'; }
  form.querySelector('input[name="data"]').value = json;
  form.submit();
})();
