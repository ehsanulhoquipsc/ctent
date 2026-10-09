(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';

  // Light / dark theme
  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') !== 'dark';
      if (dark) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('ctent-theme', dark ? 'dark' : 'light'); } catch (e) {}
    });
  });

  // Mobile sidebar
  document.querySelectorAll('[data-toggle-side]').forEach(function (b) {
    b.addEventListener('click', function () { document.getElementById('side').classList.toggle('open'); });
  });

  // Confirm before destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });

  document.querySelectorAll('[data-confirm-btn]').forEach(function (b) {
    b.addEventListener('click', function (e) { if (!window.confirm(b.getAttribute('data-confirm-btn'))) e.preventDefault(); });
  });
  // Picking 'someone else' clears the radio choice
  document.querySelectorAll('select[data-other]').forEach(function (s) {
    s.addEventListener('change', function () { if (s.value) s.form.querySelectorAll('input[name=user_id]').forEach(function (r) { r.checked = false; }); });
  });
  // Send the browser's timezone with meeting times
  document.querySelectorAll('input[name=tz]').forEach(function (i) {
    var o = -new Date().getTimezoneOffset(), sign = o >= 0 ? '+' : '-', a = Math.abs(o);
    i.value = sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
  });

  // Selects that save on change
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // Dialogs
  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('click', function () { var d = document.getElementById(b.getAttribute('data-open')); if (d && d.showModal) d.showModal(); });
  });
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { var d = b.closest('dialog'); if (d) d.close(); });
  });
  document.querySelectorAll('dialog[data-autoopen]').forEach(function (d) { if (d.showModal) d.showModal(); });

  // Fill a meeting's platform as the link is typed
  var link = document.querySelector('[data-meeting-link]');
  if (link) {
    var out = document.querySelector('[data-platform]');
    var detect = function () {
      var l = link.value.toLowerCase(), p = '';
      if (l.indexOf('zoom.us') > -1) p = 'Zoom'; else if (l.indexOf('meet.google.com') > -1) p = 'Google Meet';
      else if (l.indexOf('teams.') > -1) p = 'Microsoft Teams'; else if (l.indexOf('webex') > -1) p = 'Webex'; else if (l) p = 'Other link';
      out.textContent = p ? 'Detected: ' + p : '';
    };
    link.addEventListener('input', detect); detect();
  }

  // Kanban drag and drop (buttons work without JS too)
  var board = document.querySelector('[data-board]');
  if (board) {
    var dragged = null;
    board.querySelectorAll('[data-task]').forEach(function (t) {
      if (t.getAttribute('draggable') === 'false') return;
      t.setAttribute('draggable', 'true');
      t.addEventListener('dragstart', function (e) { dragged = t; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      t.addEventListener('dragend', function () { t.classList.remove('dragging'); });
    });
    board.querySelectorAll('[data-col]').forEach(function (col) {
      col.addEventListener('dragover', function (e) { if (dragged) { e.preventDefault(); col.classList.add('drop'); } });
      col.addEventListener('dragleave', function () { col.classList.remove('drop'); });
      col.addEventListener('drop', function (e) {
        e.preventDefault(); col.classList.remove('drop');
        if (!dragged) return;
        var status = col.getAttribute('data-col');
        col.querySelector('[data-list]').appendChild(dragged);
        fetch(dragged.getAttribute('data-move'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, 'Accept': 'application/json' }, body: JSON.stringify({ status: status }) })
          .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
          .then(function () { board.querySelectorAll('[data-col]').forEach(function (c) { var n = c.querySelectorAll('[data-task]').length; var k = c.querySelector('[data-count]'); if (k) k.textContent = n; }); var sel = dragged.querySelector('select[name=status]'); if (sel) sel.value = status; })
          .catch(function () { window.location.reload(); });
      });
    });
  }

  // Live chat: poll for new messages and send without reloading
  var chat = document.querySelector('[data-chat]');
  if (chat) {
    var box = chat.querySelector('[data-msgs]');
    var form = chat.querySelector('form');
    var last = parseInt(chat.getAttribute('data-last') || '0', 10);
    var url = chat.getAttribute('data-chat');
    var scroll = function () { box.scrollTop = box.scrollHeight; };
    var esc = function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    var render = function (m) {
      var el = document.createElement('div'); el.className = 'msg'; el.setAttribute('data-id', m.id);
      el.innerHTML = m.avatar + '<div class="body"><div class="split"><b>' + esc(m.name) + '</b><span class="mono">' + esc(m.time) + '</span></div><p>' + esc(m.body) + '</p></div>';
      box.appendChild(el);
      var e = box.querySelector('[data-empty]'); if (e) e.remove();
    };
    var poll = function () {
      fetch(url + '?after=' + last, { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
        var near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        (d.messages || []).forEach(function (m) { if (!box.querySelector('[data-id="' + m.id + '"]')) render(m); last = Math.max(last, m.id); });
        if (d.messages && d.messages.length && near) scroll();
      }).catch(function () {});
    };
    scroll();
    setInterval(poll, 3000);
    var ta = form.querySelector('textarea');
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = ta.value.trim(); if (!body) return;
      ta.value = '';
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, 'Accept': 'application/json' }, body: JSON.stringify({ body: body }) })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (m) { if (!box.querySelector('[data-id="' + m.id + '"]')) render(m); last = Math.max(last, m.id); scroll(); })
        .catch(function () { ta.value = body; alert('Message not sent. Check your connection and try again.'); });
    });
  }

  // Fade out flash messages
  var flash = document.querySelector('.alert[role=status]');
  if (flash) setTimeout(function () { flash.style.transition = 'opacity .4s'; flash.style.opacity = '0'; setTimeout(function () { flash.remove(); }, 400); }, 4000);
})();
