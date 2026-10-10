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
  // Edit/delete popovers: position on screen (so tables and scroll areas don't clip them), one open at a time
  var placePop = function (d) {
    var pop = d.querySelector('.ed-pop'), sum = d.querySelector('summary'); if (!pop || !sum) return;
    var r = sum.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    pop.style.position = 'fixed'; pop.style.right = 'auto'; pop.style.bottom = 'auto';
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.min(Math.max(16, r.right - w), vw - w - 16);
    var top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    pop.style.left = Math.max(8, left) + 'px'; pop.style.top = top + 'px';
    pop.style.maxHeight = (vh - 16) + 'px'; pop.style.overflowY = 'auto';
  };
  document.querySelectorAll('details.ed').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      document.querySelectorAll('details.ed[open]').forEach(function (o) { if (o !== d) o.open = false; });
      placePop(d);
      var f = d.querySelector('.ed-pop input:not([type=hidden]), .ed-pop textarea, .ed-pop select'); if (f) f.focus();
    });
  });
  var closeEd = function () { document.querySelectorAll('details.ed[open]').forEach(function (o) { o.open = false; }); };
  document.addEventListener('click', function (e) { if (!e.target.closest('details.ed')) closeEd(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeEd(); });
  window.addEventListener('resize', closeEd);
  document.addEventListener('scroll', function (e) { var o = document.querySelector('details.ed[open]'); if (o && !(e.target.closest && e.target.closest('.ed-pop'))) placePop(o); }, true);
  // Show existing meeting times in the browser's own timezone when editing
  document.querySelectorAll('form[data-meeting-at]').forEach(function (f) {
    var d = new Date(f.getAttribute('data-meeting-at')); if (isNaN(d)) return;
    var p = function (n) { return String(n).padStart(2, '0'); };
    var di = f.querySelector('[name=date]'), ti = f.querySelector('[name=time]');
    if (di) di.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    if (ti) ti.value = p(d.getHours()) + ':' + p(d.getMinutes());
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
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ''); return d; }); })
          .then(function () { board.querySelectorAll('[data-col]').forEach(function (c) { var n = c.querySelectorAll('[data-task]').length; var k = c.querySelector('[data-count]'); if (k) k.textContent = n; }); var sel = dragged.querySelector('select[name=status]'); if (sel) sel.value = status; })
          .catch(function (err) { if (err && err.message) alert(err.message); window.location.reload(); });
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
    var me = parseInt(chat.getAttribute('data-me') || '0', 10), mod = chat.getAttribute('data-mod') === '1', ro = chat.getAttribute('data-ro') === '1';
    var since = chat.getAttribute('data-since') || '';
    var ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    var ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
    var decorate = function (el) {
      var old = el.querySelector('.msg-actions'); if (old) old.remove();
      if (ro || el.hasAttribute('data-deleted')) return;
      var mine = parseInt(el.getAttribute('data-uid') || '0', 10) === me;
      if (!mine && !mod) return;
      var a = document.createElement('span'); a.className = 'msg-actions';
      a.innerHTML = (mine ? '<button type="button" class="mini icon-only" data-msg-edit aria-label="Edit message" title="Edit">' + ICON_EDIT + '</button>' : '') +
        '<button type="button" class="mini del icon-only" data-msg-del aria-label="Delete message" title="Delete">' + ICON_DEL + '</button>';
      el.querySelector('.split').appendChild(a);
    };
    var fill = function (el, m) {
      el.setAttribute('data-id', m.id); el.setAttribute('data-uid', m.uid || '');
      if (m.deleted) el.setAttribute('data-deleted', ''); else el.removeAttribute('data-deleted');
      el.innerHTML = m.avatar + '<div class="body"><div class="split"><b>' + esc(m.name) + '</b><span class="mono">' + esc(m.time) + '</span>' + (m.edited ? '<span class="edited">(edited)</span>' : '') + '</div><p>' + (m.deleted ? '<i class="hint">This message was deleted.</i>' : esc(m.body)) + '</p></div>';
      decorate(el);
    };
    var render = function (m) {
      var el = document.createElement('div'); el.className = 'msg';
      fill(el, m);
      box.appendChild(el);
      var e = box.querySelector('[data-empty]'); if (e) e.remove();
    };
    box.querySelectorAll('.msg').forEach(decorate);
    var send = function (id, payload) {
      return fetch(url + '/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, 'Accept': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); });
    };
    box.addEventListener('click', function (e) {
      var el = e.target.closest('.msg'); if (!el) return;
      var id = el.getAttribute('data-id');
      if (e.target.closest('[data-msg-del]')) {
        if (!confirm('Delete this message for everyone?')) return;
        send(id, { action: 'delete' }).then(function (m) { fill(el, m); }).catch(function (err) { alert(err.message); });
      } else if (e.target.closest('[data-msg-edit]')) {
        if (el.querySelector('[data-edit-box]')) return;
        var p = el.querySelector('.body p'); var text = p.textContent;
        var f = document.createElement('form'); f.setAttribute('data-edit-box', ''); f.className = 'split'; f.style.marginTop = '4px';
        f.innerHTML = '<label class="sr">Edit message</label><textarea class="in" rows="2" style="flex:1 1 240px"></textarea><button class="btn btn-p btn-sm">Save</button><button type="button" class="btn btn-s btn-sm" data-cancel>Cancel</button>';
        f.querySelector('textarea').value = text;
        p.hidden = true; p.after(f); f.querySelector('textarea').focus();
        f.querySelector('textarea').addEventListener('keydown', function (k) { if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); f.requestSubmit(); } if (k.key === 'Escape') { f.remove(); p.hidden = false; } });
        f.querySelector('[data-cancel]').addEventListener('click', function () { f.remove(); p.hidden = false; });
        f.addEventListener('submit', function (s) {
          s.preventDefault();
          var body = f.querySelector('textarea').value.trim(); if (!body) return;
          send(id, { action: 'edit', body: body }).then(function (m) { fill(el, m); }).catch(function (err) { alert(err.message); });
        });
      }
    });
    var poll = function () {
      fetch(url + '?after=' + last + '&since=' + encodeURIComponent(since), { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
        var near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        (d.messages || []).forEach(function (m) { if (!box.querySelector('[data-id="' + m.id + '"]')) render(m); last = Math.max(last, m.id); });
        (d.changed || []).forEach(function (m) { var el = box.querySelector('[data-id="' + m.id + '"]'); if (el && !el.querySelector('[data-edit-box]')) fill(el, m); });
        if (d.now) since = d.now;
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
