'use strict';
// CTENT service worker: makes the app installable and shows a friendly page when offline.
// Pages always come from the network (never stale); only the offline page is kept in the cache.
const CACHE = 'ctent-offline-v2';
const OFFLINE = ['/static/pwa/offline.html', '/static/pwa/offline.css', '/static/img/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/static/pwa/offline.html')));
    return;
  }
  const url = new URL(req.url);
  if (url.origin === location.origin && OFFLINE.includes(url.pathname)) {
    e.respondWith(fetch(req).catch(() => caches.match(url.pathname)));
  }
});
