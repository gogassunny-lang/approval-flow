// Minimal service worker: makes the app installable and keeps the shell cached.
// Data always comes live from Supabase; nothing sensitive is cached.
const SHELL = 'setu-shell-v2';
const FILES = ['./', './index.html', './app.js', './config.js', './manifest.json', './favicon.png', './logo-mark.png', './logo-lockup-white.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;                 // never intercept Supabase or CDN calls
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
