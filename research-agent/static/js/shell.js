// Same behaviour as the CTENT website shell: theme toggle, mobile sidebar, one popover open at a time.
(function () {
  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') !== 'dark';
      if (dark) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('ctent-theme', dark ? 'dark' : 'light'); } catch (e) {}
      document.dispatchEvent(new CustomEvent('ctent-theme'));
    });
  });
  document.querySelectorAll('[data-toggle-side]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); document.getElementById('side').classList.toggle('open'); });
  });
  document.addEventListener('click', function (e) {
    var side = document.getElementById('side');
    if (side && side.classList.contains('open') && !e.target.closest('#side')) side.classList.remove('open');
    if (!e.target.closest('details.ed')) document.querySelectorAll('details.ed[open]').forEach(function (o) { o.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('details.ed[open]').forEach(function (o) { o.open = false; });
  });
  document.querySelectorAll('details.ed').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) document.querySelectorAll('details.ed[open]').forEach(function (o) { if (o !== d) o.open = false; });
    });
  });
  window.ctentToast = function (text) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = text; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1600);
  };
})();
