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


  // ===== Create task: brief builder with live preview and quality score =====
  var brief = document.querySelector('[data-brief]');
  if (brief) {
    var crit = [];
    var list = brief.querySelector('[data-crit-list]');
    var input = brief.querySelector('[data-crit-input]');
    var esc2 = function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    var val = function (sel) { var el = brief.querySelector(sel); return el ? el.value.trim() : ''; };
    var labelOf = function (name) { var el = brief.querySelector('input[name="' + name + '"]:checked'); return el ? el.parentNode.textContent.trim() : ''; };
    var out = function (k, v) { brief.querySelectorAll('[data-out="' + k + '"]').forEach(function (o) { o.textContent = v; }); };
    var renderCrit = function () {
      list.innerHTML = crit.map(function (c, i) { return '<div class="crit-row"><span class="sq"></span><span style="flex:1">' + esc2(c) + '</span><input type="hidden" name="criteria" value="' + esc2(c).replace(/"/g, '&quot;') + '"><button type="button" class="btn-link" style="color:var(--muted);font-size:18px" data-crit-del="' + i + '" aria-label="Remove">×</button></div>'; }).join('');
      brief.querySelector('[data-out-crit]').innerHTML = crit.length ? crit.map(function (c) { return '<div>☐ ' + esc2(c) + '</div>'; }).join('') : '<span style="color:var(--red)">No “done when” points yet</span>';
      brief.querySelectorAll('[data-crit-sug]').forEach(function (b) { b.style.display = crit.indexOf(b.getAttribute('data-crit-sug')) > -1 ? 'none' : ''; });
      update();
    };
    var addCrit = function (t) { t = (t || '').trim(); if (t && crit.indexOf(t) === -1 && crit.length < 12) { crit.push(t); renderCrit(); } };
    brief.querySelector('[data-crit-add]').addEventListener('click', function () { addCrit(input.value); input.value = ''; input.focus(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCrit(input.value); input.value = ''; } });
    brief.querySelectorAll('[data-crit-sug]').forEach(function (b) { b.addEventListener('click', function () { addCrit(b.getAttribute('data-crit-sug')); }); });
    list.addEventListener('click', function (e) { var b = e.target.closest('[data-crit-del]'); if (b) { crit.splice(+b.getAttribute('data-crit-del'), 1); renderCrit(); } });
    brief.querySelectorAll('[data-due]').forEach(function (r) { r.addEventListener('change', function () { brief.querySelector('[data-due-input]').value = r.value; update(); }); });
    var update = function () {
      var title = val('[data-bind="title"]'), goal = val('[data-bind="goal"]');
      var verb = /^(draft|write|collect|analy[sz]e|review|translate|prepare|map|summari[sz]e|build|check|interview|code|clean|design|run|update|create|compile|test|find|read|plan|visit|record|transcribe|model|estimate|compare|survey|measure|calculate|identify|assess|evaluate|explore|investigate|outline|edit|present|share|organi[sz]e|train|book|request|submit|finali[sz]e)/i.test(title);
      var res = Array.prototype.map.call(brief.querySelectorAll('[data-bind-res]:checked'), function (c) { return c.getAttribute('data-bind-res'); });
      out('title', title || 'Untitled task');
      out('goal', goal || '—');
      var w = brief.querySelector('input[name="assignee_id"]:checked'); out('who', w ? w.getAttribute('data-name') : '—');
      out('deliverable', labelOf('deliverable') || '—');
      out('priority', labelOf('priority') || 'Normal');
      out('part', labelOf('part_id') && labelOf('part_id') !== 'None' ? labelOf('part_id') : '');
      var d = val('[data-due-input]'); out('due', d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—');
      brief.querySelector('[data-out-res]').innerHTML = res.map(function (r) { return '<span class="skill">🔗 ' + esc2(r) + '</span>'; }).join('');
      var hint = brief.querySelector('[data-verb-hint]'); if (hint) hint.textContent = verb ? 'Good — it starts with an action.' : 'Tip: start with a verb so it reads like a to-do.';
      var checks = [[title.length >= 8, 'Clear title', 'Give it a specific title'], [verb, 'Starts with an action', 'Start with a verb like Draft, Collect, Analyse'], [goal.length >= 30, 'Goal explains why', 'Add a sentence on why it matters'], [crit.length >= 2, '2+ “done when” points', 'Say how you’ll judge it’s done'], [res.length > 0 || !brief.querySelector('[data-bind-res]'), 'Starter file linked', 'Link at least one file']];
      var score = checks.filter(function (c) { return c[0]; }).length;
      brief.querySelector('[data-checks]').innerHTML = checks.map(function (c) { return '<div class="split"><span class="tag" style="background:' + (c[0] ? 'var(--green-soft);color:var(--green)' : 'var(--amber-soft);color:var(--amber)') + '">' + (c[0] ? '✓' : '!') + '</span><span style="' + (c[0] ? '' : 'color:var(--amber);font-weight:600') + '">' + (c[0] ? c[1] : c[2]) + '</span></div>'; }).join('');
      var pill = brief.querySelector('[data-score-pill]'), bar = brief.querySelector('[data-score-bar]');
      var tone = score === 5 ? ['var(--green)', 'var(--green-soft)', 'Excellent'] : score >= 3 ? ['var(--amber)', 'var(--amber-soft)', 'Good'] : ['var(--red)', 'var(--red-soft)', 'Needs work'];
      pill.textContent = score + '/5 · ' + tone[2]; pill.style.color = tone[0]; pill.style.background = tone[1];
      bar.style.width = (score * 20) + '%'; bar.style.background = tone[0];
      var ready = title.length >= 3 && crit.length >= 1;
      var send = brief.querySelector('[data-send]'); send.disabled = !ready;
      brief.querySelector('[data-send-hint]').textContent = ready ? (score === 5 ? 'Looks great. ' : 'You can send now, or improve the brief first. ') + 'They’ll be notified straight away.' : 'Add a title and at least one “done when” point to send.';
    };
    brief.addEventListener('input', update); brief.addEventListener('change', update);
    renderCrit();
  }

  // ===== Task page: review approve only when every point is ticked; quick replies =====
  var review = document.querySelector('form.review');
  if (review) {
    var boxes = review.querySelectorAll('[data-crit-check]');
    var approveBtn = review.querySelector('[data-approve]');
    var hint2 = review.querySelector('[data-review-hint]');
    var sync = function () { var n = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length; if (!boxes.length) return; approveBtn.disabled = n !== boxes.length; hint2.textContent = n === boxes.length ? 'All ' + n + ' points met — ready to approve.' : (boxes.length - n) + ' of ' + boxes.length + ' points not met yet — they’ll be sent back if you request changes.'; };
    boxes.forEach(function (b) { b.addEventListener('change', sync); }); sync();
  }
  document.querySelectorAll('[data-fill]').forEach(function (b) { b.addEventListener('click', function () { var i = b.form.querySelector('input[name=body]'); i.value = b.getAttribute('data-fill'); i.focus(); }); });

  // Fade out flash messages
  var flash = document.querySelector('.alert[role=status]');
  if (flash) setTimeout(function () { flash.style.transition = 'opacity .4s'; flash.style.opacity = '0'; setTimeout(function () { flash.remove(); }, 400); }, 4000);
})();
