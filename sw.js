/* Acacia Stock Count - keeps the app shell available offline. Data requests (Supabase) are never cached. */
var V = 'acx-stockcount-v7';
var SHELL = ['./', 'index.html', 'stocktake.css', 'stocktake.js', 'acacia-session.js', 'manifest.webmanifest', 'icon-96.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png'];
/* each file is added on its own, so one missing file can no longer stop the whole offline copy from installing */
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(V).then(function (c) { return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (k) { return Promise.all(k.filter(function (x) { return x !== V; }).map(function (x) { return caches.delete(x); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request; if (r.method !== 'GET') return;
  var u = new URL(r.url); if (u.origin !== self.location.origin) return;
  e.respondWith(fetch(r).then(function (res) {
    if (res && res.ok && res.type === 'basic') { var cp = res.clone(); caches.open(V).then(function (c) { c.put(r, cp); }); }   /* never store error pages */
    return res;
  }).catch(function () { return caches.match(r).then(function (m) { return m || caches.match('index.html'); }); }));
});
