(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  // Text written by this script, in the page's language (the server translates everything else).
  var BN = { 'Detected: ': 'শনাক্ত হয়েছে: ', 'Edit message': 'বার্তা সম্পাদনা', 'Delete message': 'বার্তা মুছুন', 'Edit': 'সম্পাদনা', 'Delete': 'মুছুন',
    '(edited)': '(সম্পাদিত)', 'This message was deleted.': 'বার্তাটি মুছে ফেলা হয়েছে।', 'Delete this message for everyone?': 'সবার জন্য বার্তাটি মুছবেন?',
    'Save': 'সংরক্ষণ', 'Cancel': 'বাতিল', 'Message not sent. Check your connection and try again.': 'বার্তা পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।', 'Something went wrong.': 'কিছু একটা ভুল হয়েছে।' };
  BN['Add a sentence on why it matters'] = 'কেন গুরুত্বপূর্ণ তা এক বাক্যে লিখুন'; BN['Add a title and at least one “done when” point to send.'] = 'পাঠাতে একটি শিরোনাম এবং কমপক্ষে একটি “সম্পন্ন হবে যখন” শর্ত যোগ করুন।'; BN['Clear title'] = 'স্পষ্ট শিরোনাম'; BN['Excellent'] = 'চমৎকার'; BN['Give it a specific title'] = 'নির্দিষ্ট একটি শিরোনাম দিন'; BN['Goal explains why'] = 'লক্ষ্যে কারণ বলা আছে'; BN['Good — it starts with an action.'] = 'ভালো — এটি একটি কাজ দিয়ে শুরু হয়েছে।'; BN['Good'] = 'ভালো'; BN['Link at least one file'] = 'অন্তত একটি ফাইল যুক্ত করুন'; BN['Looks great. '] = 'দারুণ হয়েছে। '; BN['Needs work'] = 'আরও ভালো করা দরকার'; BN['None'] = 'কিছু নেই'; BN['Normal'] = 'সাধারণ'; BN['Say how you’ll judge it’s done'] = 'কীভাবে বুঝবেন কাজ শেষ, তা লিখুন'; BN['Start with a verb like Draft, Collect, Analyse'] = 'খসড়া, সংগ্রহ, বিশ্লেষণ — এমন একটি ক্রিয়া দিয়ে শুরু করুন'; BN['Starter file linked'] = 'শুরুর ফাইল যুক্ত'; BN['Starts with an action'] = 'কাজ দিয়ে শুরু'; BN['They’ll be notified straight away.'] = 'তাদের সঙ্গে সঙ্গে জানানো হবে।'; BN['Tip: start with a verb so it reads like a to-do.'] = 'পরামর্শ: ক্রিয়া দিয়ে শুরু করুন, যাতে করণীয়র মতো পড়া যায়।'; BN['Untitled task'] = 'শিরোনামহীন কাজ'; BN['You can send now, or improve the brief first. '] = 'এখনই পাঠাতে পারেন, অথবা আগে নির্দেশনা আরও ভালো করুন। '; 
  Object.assign(BN, {"Dismiss": "বন্ধ করুন", "Undo": "ফিরিয়ে নিন", "Tip": "পরামর্শ", "of": "/", "Skip tips": "পরামর্শ বাদ দিন", "Got it": "বুঝেছি", "Next": "পরবর্তী", "Review": "পর্যালোচনা", " working": "টি কাজ করছে", " ready": "টি প্রস্তুত", "Part removed": "অংশ সরানো হয়েছে", "Template parts added — edit any of them": "টেমপ্লেটের অংশ যোগ হয়েছে — যেকোনোটি সম্পাদনা করুন", "Create & pick team": "তৈরি করে দল বাছুন", "Create & suggest parts": "তৈরি করে অংশ প্রস্তাব করুন", "Good match: ": "ভালো মিল: ", " knows ": " জানেন ", "An AI agent will research this part — you review its evidence": "একটি AI এজেন্ট এই অংশ গবেষণা করবে — আপনি তার প্রমাণ পর্যালোচনা করবেন", "Kept": "রাখা হয়েছে", "Skipped": "বাদ দেওয়া হয়েছে", "Selected ": "নির্বাচিত ", " high-reliability cards": "টি উচ্চ-নির্ভরযোগ্য কার্ড", "All high-reliability cards are already selected": "সব উচ্চ-নির্ভরযোগ্য কার্ড আগেই নির্বাচিত", "Supports: ": "সমর্থন করে: ", "Open source ↗": "উৎস খুলুন ↗", "High reliability": "উচ্চ নির্ভরযোগ্যতা", "Medium reliability": "মাঝারি নির্ভরযোগ্যতা", "Low reliability": "নিম্ন নির্ভরযোগ্যতা", "RETRACTED": "প্রত্যাহৃত", "Preprint": "প্রিপ্রিন্ট", "Tips will show again on each page": "প্রতিটি পৃষ্ঠায় আবার পরামর্শ দেখাবে", "Write the research question first (step 1) and the AI can suggest parts.": "আগে গবেষণা প্রশ্ন লিখুন (ধাপ ১), তাহলে AI অংশ প্রস্তাব করতে পারবে।", "Suggesting…": "প্রস্তাব করা হচ্ছে…", "Suggest parts": "অংশ প্রস্তাব করুন", "AI suggested ": "AI প্রস্তাব করেছে ", " parts from your question — edit any of them": "টি অংশ — যেকোনোটি সম্পাদনা করুন", "Accept N and use in paper": "Nটি গ্রহণ করে গবেষণাপত্রে ব্যবহার করুন", "Update accepted cards (N)": "গৃহীত কার্ড হালনাগাদ করুন (N)", " of ": " / ", " parts have someone.": "টি অংশে দায়িত্ব দেওয়া হয়েছে।", " go to an AI agent.": "টি যাবে AI এজেন্টের কাছে।", "Members get a notification with their brief and due date.": "সদস্যরা বিবরণ ও শেষ তারিখসহ নোটিফিকেশন পাবেন।", " agents": "টি এজেন্ট", "about ": "প্রায় ", " minutes · two run at a time. You can leave the page; you’ll be notified.": " মিনিট · একসঙ্গে দুটি চলে। পৃষ্ঠা ছেড়ে যেতে পারেন; আপনাকে জানানো হবে।", " parts go to people.": "টি অংশ যাবে সদস্যদের কাছে।"});
  var L = function (s) { return document.documentElement.lang === 'bn' && BN[s] ? BN[s] : s; };

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
  document.querySelectorAll('[data-meeting-link]').forEach(function (link) {
    var f = link.closest('.field'); var out = f && f.querySelector('[data-platform]'); if (!out) return;
    var detect = function () {
      var l = link.value.toLowerCase(), p = '';
      if (l.indexOf('zoom.us') > -1) p = 'Zoom'; else if (l.indexOf('meet.google.com') > -1) p = 'Google Meet';
      else if (l.indexOf('teams.') > -1) p = 'Microsoft Teams'; else if (l.indexOf('webex') > -1) p = 'Webex'; else if (l.indexOf('jit.si') > -1) p = 'Jitsi'; else if (l) p = 'Other link';
      out.textContent = p ? L('Detected: ') + p : '';
    };
    link.addEventListener('input', detect); detect();
  });

  // New room: picking a part or task fills in its name and people
  document.querySelectorAll('[data-room-form]').forEach(function (f) {
    var sel = f.querySelector('[data-preset]'), name = f.querySelector('[name=name]'), auto = '';
    if (!sel) return;
    sel.addEventListener('change', function () {
      var o = sel.options[sel.selectedIndex], ids = [];
      try { ids = JSON.parse(o.getAttribute('data-ids') || '[]'); } catch (e) {}
      if (ids.length || !o.value) f.querySelectorAll('[name=members]').forEach(function (c) { c.checked = c.defaultChecked || ids.indexOf(parseInt(c.value, 10)) > -1; });
      var n = o.getAttribute('data-name') || '';
      if (!name.value || name.value === auto) { name.value = n; auto = n; }
    });
  });

  document.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

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
      a.innerHTML = (mine ? '<button type="button" class="mini icon-only" data-msg-edit aria-label="' + L('Edit message') + '" title="' + L('Edit') + '">' + ICON_EDIT + '</button>' : '') +
        '<button type="button" class="mini del icon-only" data-msg-del aria-label="' + L('Delete message') + '" title="' + L('Delete') + '">' + ICON_DEL + '</button>';
      el.querySelector('.split').appendChild(a);
    };
    var fill = function (el, m) {
      el.setAttribute('data-id', m.id); el.setAttribute('data-uid', m.uid || '');
      if (m.deleted) el.setAttribute('data-deleted', ''); else el.removeAttribute('data-deleted');
      el.innerHTML = m.avatar + '<div class="body"><div class="split"><b>' + esc(m.name) + '</b><span class="mono">' + esc(m.time) + '</span>' + (m.edited ? '<span class="edited">' + L('(edited)') + '</span>' : '') + '</div><p>' + (m.deleted ? '<i class="hint">' + L('This message was deleted.') + '</i>' : esc(m.body)) + '</p></div>';
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
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || L('Something went wrong.')); return d; }); });
    };
    box.addEventListener('click', function (e) {
      var el = e.target.closest('.msg'); if (!el) return;
      var id = el.getAttribute('data-id');
      if (e.target.closest('[data-msg-del]')) {
        if (!confirm(L('Delete this message for everyone?'))) return;
        send(id, { action: 'delete' }).then(function (m) { fill(el, m); }).catch(function (err) { alert(err.message); });
      } else if (e.target.closest('[data-msg-edit]')) {
        if (el.querySelector('[data-edit-box]')) return;
        var p = el.querySelector('.body p'); var text = p.textContent;
        var f = document.createElement('form'); f.setAttribute('data-edit-box', ''); f.className = 'split'; f.style.marginTop = '4px';
        f.innerHTML = '<label class="sr">' + L('Edit message') + '</label><textarea class="in" rows="2" style="flex:1 1 240px"></textarea><button class="btn btn-p btn-sm">' + L('Save') + '</button><button type="button" class="btn btn-s btn-sm" data-cancel>' + L('Cancel') + '</button>';
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
        .catch(function () { ta.value = body; alert(L('Message not sent. Check your connection and try again.')); });
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
      out('title', title || L('Untitled task'));
      out('goal', goal || '—');
      var w = brief.querySelector('input[name="assignee_id"]:checked'); out('who', w ? w.getAttribute('data-name') : '—');
      out('deliverable', labelOf('deliverable') || '—');
      out('priority', labelOf('priority') || L('Normal'));
      out('part', labelOf('part_id') && labelOf('part_id') !== L('None') ? labelOf('part_id') : '');
      var d = val('[data-due-input]'); out('due', d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—');
      brief.querySelector('[data-out-res]').innerHTML = res.map(function (r) { return '<span class="skill">🔗 ' + esc2(r) + '</span>'; }).join('');
      var hint = brief.querySelector('[data-verb-hint]'); if (hint) hint.textContent = verb ? L('Good — it starts with an action.') : L('Tip: start with a verb so it reads like a to-do.');
      var checks = [[title.length >= 8, L('Clear title'), L('Give it a specific title')], [verb, L('Starts with an action'), L('Start with a verb like Draft, Collect, Analyse')], [goal.length >= 30, L('Goal explains why'), L('Add a sentence on why it matters')], [crit.length >= 2, '2+ “done when” points', L('Say how you’ll judge it’s done')], [res.length > 0 || !brief.querySelector('[data-bind-res]'), L('Starter file linked'), L('Link at least one file')]];
      var score = checks.filter(function (c) { return c[0]; }).length;
      brief.querySelector('[data-checks]').innerHTML = checks.map(function (c) { return '<div class="split"><span class="tag" style="background:' + (c[0] ? 'var(--green-soft);color:var(--green)' : 'var(--amber-soft);color:var(--amber)') + '">' + (c[0] ? '✓' : '!') + '</span><span style="' + (c[0] ? '' : 'color:var(--amber);font-weight:600') + '">' + (c[0] ? c[1] : c[2]) + '</span></div>'; }).join('');
      var pill = brief.querySelector('[data-score-pill]'), bar = brief.querySelector('[data-score-bar]');
      var tone = score === 5 ? ['var(--green)', 'var(--green-soft)', L('Excellent')] : score >= 3 ? ['var(--amber)', 'var(--amber-soft)', L('Good')] : ['var(--red)', 'var(--red-soft)', L('Needs work')];
      pill.textContent = score + '/5 · ' + tone[2]; pill.style.color = tone[0]; pill.style.background = tone[1];
      bar.style.width = (score * 20) + '%'; bar.style.background = tone[0];
      var ready = title.length >= 3 && crit.length >= 1;
      var send = brief.querySelector('[data-send]'); send.disabled = !ready;
      brief.querySelector('[data-send-hint]').textContent = ready ? (score === 5 ? L('Looks great. ') : L('You can send now, or improve the brief first. ')) + L('They’ll be notified straight away.') : L('Add a title and at least one “done when” point to send.');
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


  // ===== Evidence workspace: tabs, filters, card selection, copy, jump to card =====
  var ws = document.querySelector('[data-tabs]');
  if (ws) {
    var showTab = function (name) {
      var found = ws.querySelector('[data-panel="' + name + '"]') ? name : 'cards';
      ws.querySelectorAll('.tabs a').forEach(function (a) { var on = a.getAttribute('data-tab') === found; a.classList.toggle('on', on); a.setAttribute('aria-selected', on ? 'true' : 'false'); });
      ws.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== found; });
      try { history.replaceState(null, '', '#' + found); } catch (e) { /* ignore */ }
    };
    ws.querySelectorAll('[data-tab]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); showTab(a.getAttribute('data-tab')); }); });
    document.querySelectorAll('.more-menu [data-tab]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); a.closest('details').open = false; showTab(a.getAttribute('data-tab')); ws.scrollIntoView({ behavior: 'smooth' }); }); });
    if (location.hash && /^#(cards|agree|gaps|overview|log)$/.test(location.hash)) showTab(location.hash.slice(1));
    else if (location.hash && /^#c\d+$/.test(location.hash)) showTab('cards');

    var form = ws.querySelector('[data-cards]');
    var cards = form ? Array.prototype.slice.call(form.querySelectorAll('[data-card]')) : [];
    var val = function (sel) { var el = ws.querySelector('[data-f="' + sel + '"]'); return el ? (el.type === 'checkbox' ? el.checked : el.value) : ''; };
    var visible = [];
    var apply = function () {
      var t = String(val('text')).toLowerCase().trim(), q = val('q'), ty = val('type'), src = val('source'), sort = val('sort') || 'score';
      var tiers = Array.prototype.map.call(ws.querySelectorAll('[data-f="tier"]:checked'), function (c) { return c.value; });
      visible = cards.filter(function (c) {
        var d = c.dataset, rel = d.rel === '' ? null : +d.rel;
        return (!t || d.text.indexOf(t) >= 0) && (!q || d.q === q) && (!ty || d.type === ty) && (!src || (' ' + d.src + ' ').indexOf(' ' + src + ' ') >= 0) &&
          tiers.indexOf(d.tier) >= 0 && (!val('hideflag') || d.flag !== '1') && (!val('rel') || rel === null || rel >= 2) && (!val('full') || d.full === '1') &&
          (!val('data') || d.data === '1') && (!val('highonly') || d.tier === 'high') && (!val('sel') || c.querySelector('input[name=card]').checked);
      });
      var grouped = !q && sort === 'score';
      var key = { score: function (c) { return +c.dataset.score; }, year: function (c) { return +c.dataset.year; }, cited: function (c) { return +c.dataset.cited; } }[sort];
      var order = cards.slice().sort(function (a, b) { return grouped ? (a.dataset.q.localeCompare(b.dataset.q) || key(b) - key(a)) : key(b) - key(a); });
      var heads = form.querySelectorAll('[data-qhead]');
      var foot = form.querySelector('.cards-foot'), none = form.querySelector('[data-nomatch]');
      var lastQ = null;
      order.forEach(function (c) {
        if (grouped && c.dataset.q !== lastQ) { lastQ = c.dataset.q; var h = form.querySelector('[data-qhead="' + CSS.escape(c.dataset.q) + '"]'); if (h) form.insertBefore(h, none || foot); }
        form.insertBefore(c, none || foot);
        c.hidden = visible.indexOf(c) < 0;
      });
      heads.forEach(function (h) { h.hidden = !grouped || !visible.some(function (c) { return c.dataset.q === h.getAttribute('data-qhead'); }); });
      if (none) none.hidden = visible.length > 0;
      var shown = ws.querySelector('[data-shown]'); if (shown) shown.textContent = visible.length + ' of ' + cards.length + ' shown';
    };
    ws.querySelectorAll('[data-f]').forEach(function (el) { el.addEventListener(el.tagName === 'INPUT' && el.type !== 'checkbox' ? 'input' : 'change', apply); });
    if (form) apply();

    var count = function () {
      var n = cards.filter(function (c) { return c.querySelector('input[name=card]').checked; }).length;
      document.querySelectorAll('[data-sel-count]').forEach(function (e) { e.textContent = n; });
      document.querySelectorAll('[data-accept-label]').forEach(function (b) { b.textContent = L(b.getAttribute('data-accept-label')).replace('N', n); b.disabled = !n; });
    };
    count();
    var save = function (ids, on) {
      if (!form || !ids.length) return;
      fetch(form.getAttribute('data-select-url'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, 'Accept': 'application/json' }, body: JSON.stringify({ ids: ids, selected: on }) }).catch(function () {});
    };
    cards.forEach(function (c) {
      var box = c.querySelector('input[name=card]');
      if (!box || box.disabled) return;
      box.addEventListener('change', function () { c.classList.toggle('sel', box.checked); count(); save([+box.value], box.checked); });
    });
    ws.querySelectorAll('[data-select-visible]').forEach(function (b) {
      b.addEventListener('click', function () {
        var on = b.getAttribute('data-select-visible') === '1', ids = [];
        visible.forEach(function (c) { var box = c.querySelector('input[name=card]'); if (box && !box.disabled && box.checked !== on) { box.checked = on; c.classList.toggle('sel', on); ids.push(+box.value); } });
        count(); save(ids, on);
      });
    });
    ws.querySelectorAll('[data-select-high]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ids = [];
        cards.forEach(function (c) { var box = c.querySelector('input[name=card]'); if (c.dataset.tier === 'high' && c.dataset.flag !== '1' && box && !box.disabled && !box.checked) { box.checked = true; c.classList.add('sel'); ids.push(+box.value); } });
        count(); save(ids, true); toast(ids.length ? L('Selected ') + ids.length + L(' high-reliability cards') : L('All high-reliability cards are already selected'));
      });
    });
    ws.querySelectorAll('[data-quick-high]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); var hb = ws.querySelector('[data-f="highonly"]'); if (hb) { hb.checked = !hb.checked; showTab('cards'); apply(); } });
    });
    // Phone: swipe a card right to keep it, left to skip it
    cards.forEach(function (c) {
      var box = c.querySelector('input[name=card]'); if (!box || box.disabled) return;
      var x0 = null, y0 = null, dx = 0;
      c.addEventListener('touchstart', function (e) { if (e.touches.length !== 1) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; }, { passive: true });
      c.addEventListener('touchmove', function (e) { if (x0 === null) return; dx = e.touches[0].clientX - x0; var dy = e.touches[0].clientY - y0; if (Math.abs(dy) > Math.abs(dx)) { x0 = null; c.style.transform = ''; return; } c.style.transform = 'translateX(' + Math.max(-90, Math.min(90, dx)) + 'px)'; c.style.background = dx > 40 ? 'var(--green-soft)' : dx < -40 ? 'var(--surface-2)' : ''; }, { passive: true });
      c.addEventListener('touchend', function () {
        if (x0 === null) return; x0 = null; c.style.transform = ''; c.style.background = '';
        if (Math.abs(dx) < 70) return;
        var on = dx > 0; if (box.checked === on) return;
        box.checked = on; c.classList.toggle('sel', on); count(); save([+box.value], on); toast(on ? L('Kept') : L('Skipped'));
      });
    });
    ws.querySelectorAll('[data-toggle]').forEach(function (b) { b.addEventListener('click', function () { var el = document.querySelector(b.getAttribute('data-toggle')); if (el) el.hidden = !el.hidden; }); });
    ws.querySelectorAll('[data-jump]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        ws.querySelectorAll('[data-f]').forEach(function (el) { if (el.type === 'checkbox') el.checked = el.getAttribute('data-f') === 'tier'; else if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = ''; });
        showTab('cards'); apply();
        var c = document.getElementById('c' + a.getAttribute('data-jump'));
        if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
      });
    });
  }
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () { var old = b.lastChild.textContent; b.lastChild.textContent = ' Copied'; setTimeout(function () { b.lastChild.textContent = old; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {}); else done();
    });
  });
  // Bangla research ticks the Bangladesh sources
  document.querySelectorAll('[data-lang-pick] input[value=bn]').forEach(function (r) {
    r.addEventListener('change', function () { if (!r.checked) return; var f = r.closest('form'); if (f) f.querySelectorAll('input[data-bd]').forEach(function (b) { b.checked = true; }); });
  });


  // ===== New project: details → mode → agents or team (all steps show without JS) =====
  var wiz = document.querySelector('[data-wizard]');
  if (wiz) {
    wiz.classList.add('js');
    var go = function (n) {
      wiz.querySelectorAll('[data-pane]').forEach(function (p) { p.classList.toggle('on', p.getAttribute('data-pane') === String(n)); });
      wiz.querySelectorAll('[data-wstep]').forEach(function (li) { var k = +li.getAttribute('data-wstep'); li.classList.toggle('on', k === n); li.classList.toggle('past', k < n); });
      var tt = wiz.querySelector('#title');
      wiz.querySelectorAll('[data-echo-title]').forEach(function (e) { e.textContent = tt ? tt.value : ''; });
      if (n === 3 && wiz.getAttribute('data-ai') === '1' && !filled() && !wiz.__asked) { wiz.__asked = true; suggest(); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    wiz.querySelectorAll('[data-wnext]').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = +b.getAttribute('data-wnext');
        var tt = wiz.querySelector('#title');
        if (n > 1 && tt && !tt.checkValidity()) { go(1); tt.reportValidity(); return; }
        go(n);
      });
    });
    var mode = function () { var m = wiz.querySelector('input[name=mode]:checked'); return m ? m.value : 'agent'; };
    var rowsBox = wiz.querySelector('[data-prows]');
    var rows = function () { return Array.prototype.slice.call(rowsBox.querySelectorAll('[data-prow]')); };
    var filled = function () { return rows().some(function (r) { return r.querySelector('[name=part_title]').value.trim(); }); };
    var picked = function () { return Array.prototype.map.call(wiz.querySelectorAll('input[name=invite]:checked'), function (c) { return c.value; }); };
    var words = function (s) { return String(s || '').toLowerCase().split(/[^a-zঀ-৿]+/).filter(function (w) { return w.length > 3; }); };
    var syncRow = function (r) {
      var sel = r.querySelector('[data-who]'), v = sel.value, isP = v && v !== 'agent';
      r.classList.toggle('is-person', !!isP); r.classList.toggle('is-agent', v === 'agent');
      var m = r.querySelector('[data-match]'), opt = sel.options[sel.selectedIndex];
      if (isP && opt) {
        var skills = (opt.getAttribute('data-skills') || '').split('|').filter(Boolean), need = words(r.querySelector('[name=part_title]').value + ' ' + r.querySelector('[name=part_brief]').value);
        var hit = skills.filter(function (sk) { return words(sk).some(function (w) { return need.some(function (n) { return n.indexOf(w.slice(0, 5)) === 0 || w.indexOf(n.slice(0, 5)) === 0; }); }); })[0];
        var name = opt.textContent.split(' — ')[0];
        m.hidden = false; m.classList.toggle('good', !!hit);
        m.textContent = hit ? '✓ ' + L('Good match: ') + name + L(' knows ') + hit.toLowerCase() : name + (skills[0] ? ' · ' + skills[0] : '');
        var box = wiz.querySelector('input[name=invite][value="' + v + '"]'); if (box && !box.checked) { box.checked = true; team(); }
      } else if (v === 'agent') { m.hidden = false; m.classList.remove('good'); m.textContent = '✦ ' + L('An AI agent will research this part — you review its evidence'); }
      else m.hidden = true;
    };
    var summary = function () {
      var rs = rows().filter(function (r) { return r.querySelector('[name=part_title]').value.trim(); });
      var ag = rs.filter(function (r) { return r.querySelector('[data-who]').value === 'agent'; }).length;
      var ps = rs.filter(function (r) { var v = r.querySelector('[data-who]').value; return v && v !== 'agent'; }).length;
      var el = wiz.querySelector('[data-wiz-summary]'); if (!el) return;
      var d = wiz.querySelector('input[name=depth]:checked'), per = { quick: 3, standard: 8, deep: 20 }[d ? d.value : 'standard'];
      el.textContent = mode() === 'manual'
        ? ps + L(' of ') + rs.length + L(' parts have someone.') + (ag ? ' ' + ag + L(' go to an AI agent.') : '') + ' ' + L('Members get a notification with their brief and due date.')
        : ag + L(' agents') + (ag ? ' · ' + L('about ') + Math.ceil(ag / 2) * per + L(' minutes · two run at a time. You can leave the page; you’ll be notified.') : '') + (ps ? ' ' + ps + L(' parts go to people.') : '');
    };
    var renumber = function () { rows().forEach(function (r, i) { r.querySelector('.prow-n').textContent = (i < 9 ? '0' : '') + (i + 1); }); summary(); };
    var bindRow = function (r) {
      r.querySelector('[data-who]').addEventListener('change', function () { r.__touched = true; syncRow(r); summary(); });
      r.querySelector('[name=part_title]').addEventListener('input', function () { syncRow(r); summary(); });
      r.querySelector('[data-remove-part]').addEventListener('click', function () {
        var next = r.nextSibling, parent = r.parentNode; parent.removeChild(r); renumber();
        toast(L('Part removed'), { label: L('Undo'), grey: true, onAct: function () { parent.insertBefore(r, next); renumber(); } });
      });
      syncRow(r);
    };
    var tmpl = rows()[0].cloneNode(true);
    var addRow = function (p) {
      var r = tmpl.cloneNode(true), k = Date.now() + Math.random();
      r.querySelectorAll('[id]').forEach(function (el) { var id = el.id.replace(/\d.*$/, '') + String(k).replace('.', ''); var l = r.querySelector('label[for="' + el.id + '"]'); if (l) l.setAttribute('for', id); el.id = id; });
      r.querySelector('[name=part_title]').value = p && p.title || ''; r.querySelector('[name=part_brief]').value = p && p.brief || ''; r.querySelector('[name=part_due]').value = '';
      r.querySelector('[data-who]').value = mode() === 'agent' ? 'agent' : '';
      rowsBox.appendChild(r); bindRow(r); renumber();
      return r;
    };
    rows().forEach(bindRow);
    var fill = function (list) {
      var empty = rows().filter(function (r) { return !r.querySelector('[name=part_title]').value.trim(); });
      list.forEach(function (p) { var r = empty.shift(); if (r) { r.querySelector('[name=part_title]').value = p.title; r.querySelector('[name=part_brief]').value = p.brief || ''; syncRow(r); } else addRow(p); });
      empty.forEach(function (r) { if (rows().length > 1) r.parentNode.removeChild(r); });
      renumber();
    };
    wiz.querySelectorAll('[data-add-part]').forEach(function (b) { b.addEventListener('click', function () { var r = addRow(); r.querySelector('[name=part_title]').focus(); }); });
    var tpls = {}; try { tpls = JSON.parse(wiz.getAttribute('data-templates') || '{}'); } catch (e) { /* ignore */ }
    wiz.querySelectorAll('[data-template]').forEach(function (b) { b.addEventListener('click', function () { b.closest('details').open = false; fill((tpls[b.getAttribute('data-template')] || []).map(function (x) { return { title: x[0], brief: x[1] }; })); toast(L('Template parts added — edit any of them')); }); });
    var suggest = function () {
      var q = wiz.querySelector('#question'), sb = wiz.querySelector('[data-suggest]');
      if (!q || q.value.trim().length < 10) { toast(L('Write the research question first (step 1) and the AI can suggest parts.')); return; }
      if (sb) { sb.disabled = true; sb.lastChild.textContent = L('Suggesting…'); }
      fetch('/topics/suggest-parts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' }, body: JSON.stringify({ question: q.value, title: (wiz.querySelector('#title') || {}).value }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.parts && d.parts.length) { fill(d.parts); toast(L('AI suggested ') + d.parts.length + L(' parts from your question — edit any of them')); } else toast(d.error || L('Something went wrong.'), { grey: true });
        }).catch(function () { toast(L('Something went wrong.'), { grey: true }); })
        .then(function () { if (sb) { sb.disabled = false; sb.lastChild.textContent = L('Suggest parts'); } });
    };
    var sb0 = wiz.querySelector('[data-suggest]'); if (sb0) sb0.addEventListener('click', suggest);
    var team = function () { var n = picked().length; wiz.querySelectorAll('[data-team-n]').forEach(function (e) { e.textContent = n; }); };
    wiz.querySelectorAll('input[name=invite]').forEach(function (c) { c.addEventListener('change', team); }); team();
    var ps = wiz.querySelector('[data-people-search]');
    if (ps) ps.addEventListener('input', function () { var q = ps.value.toLowerCase().trim(); wiz.querySelectorAll('[data-person]').forEach(function (p) { p.hidden = q && p.getAttribute('data-text').indexOf(q) < 0; }); });
    var setMode = function () {
      var m = mode(); wiz.setAttribute('data-mode', m);
      rows().forEach(function (r) { if (!r.__touched) { var s = r.querySelector('[data-who]'); if (s.value === 'agent' || s.value === '') s.value = m === 'agent' ? 'agent' : ''; syncRow(r); } });
      summary();
    };
    wiz.querySelectorAll('input[name=mode], input[name=depth]').forEach(function (r) { r.addEventListener('change', setMode); });
    setMode();
    go(1);
  }
  // Links that open a <details> section (e.g. "Add a part")
  document.querySelectorAll('[data-open]').forEach(function (a) {
    a.addEventListener('click', function () { var d = document.querySelector(a.getAttribute('data-open')); if (d) { d.open = true; setTimeout(function () { var i = d.querySelector('input:not([type=hidden])'); if (i) i.focus(); }, 50); } });
  });

  // Fade out flash messages
  var flash = document.querySelector('.alert[role=status]');
  if (flash) setTimeout(function () { flash.style.transition = 'opacity .4s'; flash.style.opacity = '0'; setTimeout(function () { flash.remove(); }, 400); }, 4000);

  // ===== Toasts: short notices with an optional action (Review, Undo) =====
  var toastBox = document.getElementById('toasts');
  function toast(msg, opt) {
    opt = opt || {};
    if (!toastBox) return null;
    var el = document.createElement('div'); el.className = 'toast2'; el.setAttribute('role', 'status');
    var dot = document.createElement('span'); dot.className = 'td'; if (opt.grey) dot.style.background = '#A39E97'; el.appendChild(dot);
    var m = document.createElement('span'); m.className = 'tm'; m.textContent = msg; el.appendChild(m);
    if (opt.label) {
      var a = document.createElement(opt.href ? 'a' : 'button'); a.className = 'ta'; a.textContent = opt.label;
      if (opt.href) a.href = opt.href; else a.type = 'button';
      if (opt.onAct) a.addEventListener('click', function (e) { if (!opt.href) e.preventDefault(); opt.onAct(); close(); });
      el.appendChild(a);
    }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'tx'; x.setAttribute('aria-label', L('Dismiss')); x.textContent = '✕'; el.appendChild(x);
    function close() { if (el.parentNode) el.parentNode.removeChild(el); if (opt.onClose) opt.onClose(); opt.onClose = null; }
    x.addEventListener('click', close);
    toastBox.appendChild(el);
    while (toastBox.children.length > 3) toastBox.removeChild(toastBox.firstChild);
    if (opt.ms !== 0) setTimeout(close, opt.ms || 5000);
    return { close: close };
  }
  window.ctToast = toast;

  // ===== Live agent progress: no reload — bars move, finished agents announce themselves =====
  var poll = document.querySelector('[data-agent-poll]');
  if (poll) {
    var seen = null, baseTitle = document.title, timer = null;
    var softRefresh = function () {
      fetch(location.href, { headers: { Accept: 'text/html' } }).then(function (r) { return r.text(); }).then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var regions = document.querySelectorAll('[data-live]');
        if (!regions.length) return;
        regions.forEach(function (el) { var n = doc.querySelector('[data-live="' + el.getAttribute('data-live') + '"]'); if (n) el.replaceWith(document.importNode(n, true)); });
        bindUndo(document);
      }).catch(function () {});
    };
    var tick = function () {
      fetch(poll.getAttribute('data-agent-poll'), { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
        var now = {}, changed = false, working = 0, ready = 0;
        (d.parts || []).forEach(function (p) {
          now[p.id] = p.status;
          if (p.status === 'queued' || p.status === 'running') working++;
          if (p.status === 'review') ready++;
          if (seen && seen[p.id] !== undefined && seen[p.id] !== p.status) {
            changed = true;
            if (p.status === 'review') toast(p.doneMsg, { label: L('Review'), href: p.href, ms: 12000 });
            if (p.status === 'failed') toast(p.failMsg, { grey: true, ms: 8000 });
          }
          document.querySelectorAll('[data-agent="' + p.id + '"]').forEach(function (el) {
            var bar = el.querySelector('[data-progress] .bar > span'); if (bar) bar.style.width = (p.progress || 0) + '%';
            var st = el.querySelector('[data-step]'); if (st && p.step) st.textContent = p.step;
            var pl = el.querySelector('[data-plain]'); if (pl && p.plain) pl.textContent = p.plain;
            var lf = el.querySelector('[data-left]'); if (lf) lf.textContent = p.leftText || '';
            var pc = el.querySelector('[data-pct]'); if (pc) pc.textContent = (p.progress || 0) + '%';
          });
        });
        document.title = (ready ? '(' + ready + ') ' : '') + baseTitle;
        var live = document.querySelector('[data-live-count]'); if (live) live.textContent = working ? working + L(' working') + ' · ' + ready + L(' ready') : ready + L(' ready');
        if (changed) {
          // The evidence page itself changes completely when its run finishes, so reload that one.
          if (document.querySelector('[data-reload-on-change]')) { setTimeout(function () { location.reload(); }, 1200); return; }
          softRefresh();
        }
        seen = now;
        if (!working && timer) { clearInterval(timer); timer = null; }
      }).catch(function () {});
    };
    tick(); timer = setInterval(tick, 4000);
  }

  // ===== Undo instead of “are you sure?”: hide now, delete after a few seconds =====
  var pending = [];
  function commit(p) {
    if (p.done) return; p.done = true;
    var fd = new FormData(p.form);
    if (navigator.sendBeacon && p.beacon) { navigator.sendBeacon(p.form.action, fd); return; }
    fetch(p.form.action, { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf } }).catch(function () {});
  }
  function bindUndo(root) {
    root.querySelectorAll('form[data-undo]').forEach(function (f) {
      if (f.__undo) return; f.__undo = true;
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var target = f.closest('[data-undo-target]') || f;
        var pop = f.closest('details'); if (pop) pop.open = false;
        target.hidden = true;
        var p = { form: f, done: false };
        pending.push(p);
        p.timer = setTimeout(function () { commit(p); }, 6000);
        toast(f.getAttribute('data-undo'), { label: L('Undo'), grey: true, ms: 6000, onAct: function () { clearTimeout(p.timer); p.done = true; target.hidden = false; } });
      });
    });
  }
  bindUndo(document);
  window.addEventListener('pagehide', function () { pending.forEach(function (p) { if (!p.done) { clearTimeout(p.timer); p.beacon = true; commit(p); } }); });

  // ===== Quick-add: “/” anywhere opens a new research question =====
  var qa = document.getElementById('quick-add');
  if (qa) {
    var qq = qa.querySelector('textarea'), guess = qa.querySelector('[data-qa-guess]'), gt = qa.querySelector('[data-qa-title]'), go2 = qa.querySelector('[data-qa-go]');
    var last = null;
    var open = function () { last = document.activeElement; qa.hidden = false; setTimeout(function () { qq.focus(); }, 20); };
    var shut = function () { qa.hidden = true; if (last && last.focus) last.focus(); };
    var titleOf = function (q) { return q.trim().replace(/\?$/, '').replace(/^(does|do|how|what|why|is|are|can|will|should)\s+/i, '').replace(/^./, function (c) { return c.toUpperCase(); }).slice(0, 80); };
    var sync = function () {
      var q = qq.value.trim(); guess.hidden = !q; gt.textContent = titleOf(q);
      var m = qa.querySelector('input[name=mode]:checked');
      go2.firstChild.textContent = m && m.value === 'manual' ? L('Create & pick team') + ' ' : L('Create & suggest parts') + ' ';
    };
    qq.addEventListener('input', sync); qa.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', sync); }); sync();
    document.querySelectorAll('[data-quick-add]').forEach(function (b) { b.addEventListener('click', open); });
    qa.querySelector('[data-qa-close]').addEventListener('click', shut);
    qa.addEventListener('click', function (e) { if (e.target === qa) shut(); });
    qq.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (qq.value.trim().length >= 10) qa.querySelector('form').requestSubmit(); else qq.reportValidity(); } });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !qa.hidden) { shut(); return; }
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      var a = document.activeElement, tag = a && a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
      e.preventDefault(); open();
    });
    qq.setAttribute('minlength', '10');
  }

  // ===== First-run tips: shown once per page, then never again =====
  var tipsKey = document.body.getAttribute('data-tips');
  var tipEls = tipsKey ? Array.prototype.slice.call(document.querySelectorAll('[data-tip]')).filter(function (el) { return el.offsetParent !== null; }).slice(0, 3) : [];
  var seenTips = null;
  try { seenTips = localStorage.getItem('ct-tips-' + tipsKey); } catch (e) { seenTips = '1'; }
  if (tipEls.length && !seenTips) {
    var veil = document.createElement('div'); veil.className = 'tip-veil';
    var box = document.createElement('div'); box.className = 'tip-box'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-live', 'polite');
    var i = 0;
    var done = function () { try { localStorage.setItem('ct-tips-' + tipsKey, '1'); } catch (e) { /* ignore */ } tipEls.forEach(function (el) { el.classList.remove('tip-on'); }); veil.remove(); box.remove(); };
    var show = function () {
      tipEls.forEach(function (el) { el.classList.remove('tip-on'); });
      var el = tipEls[i]; el.classList.add('tip-on');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      box.innerHTML = '';
      var n = document.createElement('span'); n.className = 'mono'; n.textContent = L('Tip') + ' ' + (i + 1) + ' ' + L('of') + ' ' + tipEls.length; box.appendChild(n);
      if (el.getAttribute('data-tip-title')) { var b = document.createElement('b'); b.textContent = el.getAttribute('data-tip-title'); box.appendChild(b); }
      var p = document.createElement('p'); p.textContent = el.getAttribute('data-tip'); box.appendChild(p);
      var row = document.createElement('div'); row.className = 'tb';
      var sk = document.createElement('button'); sk.type = 'button'; sk.className = 'skip'; sk.textContent = L('Skip tips'); sk.addEventListener('click', done);
      var nx = document.createElement('button'); nx.type = 'button'; nx.className = 'go'; nx.textContent = i >= tipEls.length - 1 ? L('Got it') : L('Next');
      nx.addEventListener('click', function () { if (i >= tipEls.length - 1) done(); else { i++; show(); } });
      row.appendChild(sk); row.appendChild(nx); box.appendChild(row);
      setTimeout(function () {
        var r = el.getBoundingClientRect();
        var top = r.bottom + window.scrollY + 12, left = Math.min(Math.max(16, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - 336);
        if (r.bottom + 200 > window.innerHeight && r.top > 220) top = r.top + window.scrollY - box.offsetHeight - 12;
        box.style.top = top + 'px'; box.style.left = left + 'px'; nx.focus({ preventScroll: true });
      }, 350);
    };
    document.body.appendChild(veil); document.body.appendChild(box);
    veil.addEventListener('click', done);
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && box.parentNode) { done(); document.removeEventListener('keydown', esc); } });
    setTimeout(show, 600);
  }

  // ===== Writing page: citation popovers, drag evidence into the text, search, phone sheet =====
  var pv = document.querySelector('.paper-view[data-cites]');
  var pop = document.querySelector('.cite-pop');
  if (pv && pop) {
    var cites = {}; try { cites = JSON.parse(pv.getAttribute('data-cites') || '{}'); } catch (e) { /* ignore */ }
    var host = pop.parentNode, hideT = null, onChip = null;
    var TIERS = { high: 'High reliability', medium: 'Medium reliability', low: 'Low reliability' };
    var showPop = function (chip) {
      var c = cites[chip.getAttribute('data-cite')]; if (!c) return;
      clearTimeout(hideT); if (onChip) onChip.classList.remove('on'); onChip = chip; chip.classList.add('on');
      pop.innerHTML = '';
      var top = document.createElement('div'); top.className = 'split';
      var tg = document.createElement('span'); tg.className = 'tag t-' + c.tier; tg.textContent = L(TIERS[c.tier] || c.tier); top.appendChild(tg);
      (c.flags || []).forEach(function (f) { var x = document.createElement('span'); x.className = 'tag f-' + f; x.textContent = f === 'retracted' ? L('RETRACTED') : f === 'preprint' ? L('Preprint') : f; top.appendChild(x); });
      var y = document.createElement('span'); y.className = 'hint'; y.textContent = '[' + c.n + '] · ' + c.year; top.appendChild(y); pop.appendChild(top);
      var t1 = document.createElement('div'); t1.className = 'cp-t'; t1.textContent = c.title; pop.appendChild(t1);
      if (c.authors) { var a = document.createElement('div'); a.className = 'hint'; a.textContent = c.authors; pop.appendChild(a); }
      if (c.finding) { var f = document.createElement('div'); f.className = 'cp-sup'; f.textContent = L('Supports: ') + '“' + c.finding + '”'; pop.appendChild(f); }
      if (c.url) { var l = document.createElement('a'); l.href = c.url; l.target = '_blank'; l.rel = 'noopener noreferrer'; l.textContent = L('Open source ↗'); l.style.fontSize = '13px'; l.style.fontWeight = '600'; pop.appendChild(l); }
      pop.hidden = false;
      var hr = host.getBoundingClientRect(), cr = chip.getBoundingClientRect();
      var left = Math.max(12, Math.min(cr.left - hr.left - 40, hr.width - pop.offsetWidth - 12));
      var topPx = cr.bottom - hr.top + 8;
      if (cr.bottom + pop.offsetHeight + 16 > window.innerHeight && cr.top - pop.offsetHeight > 80) topPx = cr.top - hr.top - pop.offsetHeight - 8;
      pop.style.left = left + 'px'; pop.style.top = topPx + 'px';
    };
    var hidePop = function () { hideT = setTimeout(function () { pop.hidden = true; if (onChip) onChip.classList.remove('on'); onChip = null; }, 180); };
    pv.querySelectorAll('.cite-chip').forEach(function (b) {
      b.addEventListener('mouseenter', function () { showPop(b); }); b.addEventListener('mouseleave', hidePop);
      b.addEventListener('focus', function () { showPop(b); }); b.addEventListener('blur', hidePop);
      b.addEventListener('click', function () { if (onChip === b && !pop.hidden) { pop.hidden = true; b.classList.remove('on'); onChip = null; } else showPop(b); });
    });
    pop.addEventListener('mouseenter', function () { clearTimeout(hideT); }); pop.addEventListener('mouseleave', hidePop);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') pop.hidden = true; });
  }
  var paperMain = document.querySelector('.w-paper[data-drop]');
  if (paperMain && paperMain.getAttribute('data-drop')) {
    var dragged = null;
    document.querySelectorAll('.w-card[draggable="true"]').forEach(function (c) {
      c.addEventListener('dragstart', function (e) { dragged = c; c.classList.add('drag'); paperMain.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', c.getAttribute('data-finding')); e.dataTransfer.effectAllowed = 'copy'; } catch (x) { /* ignore */ } });
      c.addEventListener('dragend', function () { c.classList.remove('drag'); paperMain.classList.remove('dragging', 'over'); dragged = null; });
    });
    paperMain.addEventListener('dragover', function (e) { if (!dragged) return; e.preventDefault(); paperMain.classList.add('over'); });
    paperMain.addEventListener('dragleave', function (e) { if (!paperMain.contains(e.relatedTarget)) paperMain.classList.remove('over'); });
    paperMain.addEventListener('drop', function (e) {
      if (!dragged) return; e.preventDefault();
      var form = dragged.querySelector('form'); paperMain.classList.remove('dragging', 'over');
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  }
  var evq = document.querySelector('[data-ev-search]');
  if (evq) evq.addEventListener('input', function () { var q = evq.value.toLowerCase().trim(); document.querySelectorAll('.w-card').forEach(function (c) { c.hidden = q && c.getAttribute('data-text').indexOf(q) < 0; }); });
  document.querySelectorAll('[data-sheet-toggle]').forEach(function (b) {
    var sheet = b.closest('.w-ev');
    b.addEventListener('click', function () { var on = !sheet.classList.contains('open'); sheet.classList.toggle('open', on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); });
    var y0 = null;
    b.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
    b.addEventListener('touchend', function (e) { if (y0 === null) return; var dy = e.changedTouches[0].clientY - y0; y0 = null; if (Math.abs(dy) > 30) { var on = dy < 0; sheet.classList.toggle('open', on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); } }, { passive: true });
  });
  document.querySelectorAll('[data-reset-tips]').forEach(function (b) { b.addEventListener('click', function () { try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('ct-tips-') === 0) localStorage.removeItem(k); }); } catch (e) { /* ignore */ } toast(L('Tips will show again on each page')); }); });
})();
