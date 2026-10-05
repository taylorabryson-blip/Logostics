/* Logostics service worker — keep this file next to index.html (same folder, same site).
   1) Makes the app open instantly and keep working with no connection (only the app's own files are cached; sign-in data, Supabase calls and music are never cached here).
   2) Receives real push notifications while the app is closed and opens the right screen when one is tapped.
   Bump VERSION whenever this file changes so phones pick up the new copy. */
const VERSION = 'logostics-sw-3.5.0';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k.indexOf('logostics') === 0).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Only the app's own files, only GET, never ranged (audio/video) or credentialed API traffic.
function cacheable(req) {
  if (req.method !== 'GET') return false;
  if (req.headers.has('range')) return false;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return false;
  if (/\/(music|audio)\//i.test(u.pathname) || /\.(mp3|m4a|ogg|wav|mp4|webm)$/i.test(u.pathname)) return false;
  if (u.pathname.indexOf('/functions/') >= 0 || u.pathname.indexOf('/rest/') >= 0 || u.pathname.indexOf('/realtime/') >= 0) return false;
  return true;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (!cacheable(req)) return;
  if (req.mode === 'navigate') {
    // pages: network first so updates arrive, cached copy when offline
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => caches.match(req).then((m) => m || caches.match('./') || caches.match('index.html')).then((m) => m || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })))
    );
    return;
  }
  // everything else: instant from cache, refreshed in the background
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* ───────── push ───────── */
function parse(e) {
  try { const j = e.data && e.data.json(); if (j && typeof j === 'object') return j; } catch (_e) { /* not JSON */ }
  try { const t = e.data && e.data.text(); if (t) return { title: 'Logostics', body: String(t).slice(0, 200) }; } catch (_e) { /* no body */ }
  return {};
}

self.addEventListener('push', (e) => {
  const p = parse(e);
  const title = String(p.title || 'Logostics').slice(0, 80);
  const kind = String(p.kind || '');
  const opts = {
    body: String(p.body || 'You have a new notification.').slice(0, 300),
    tag: String(p.tag || 'logostics').slice(0, 60),
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    data: { url: typeof p.url === 'string' && p.url.charAt(0) === '#' ? p.url : '#n=' + (kind || 'open'), kind, cat: String(p.cat || '') },
    renotify: true,
    timestamp: Date.now(),
    requireInteraction: p.cat === 'security',
  };
  // A visible notification must always be shown (browsers drop push permission for silent pushes).
  e.waitUntil(
    self.registration.showNotification(title, opts).then(() => {
      // keep the app-icon badge in step where the platform supports it
      if (self.navigator && self.navigator.setAppBadge) {
        return self.registration.getNotifications().then((ns) => self.navigator.setAppBadge(ns.length)).catch(() => {});
      }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const hash = typeof d.url === 'string' && d.url.charAt(0) === '#' ? d.url : '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const mine = list.find((c) => c.url.indexOf(self.registration.scope) === 0) || list[0];
      if (mine) {
        mine.postMessage({ type: 'lg-nav', hash, kind: d.kind || '' });
        return 'focus' in mine ? mine.focus() : undefined;
      }
      return self.clients.openWindow(self.registration.scope + hash);
    }).then(() => {
      if (self.navigator && self.navigator.clearAppBadge) {
        return self.registration.getNotifications().then((ns) => (ns.length ? self.navigator.setAppBadge(ns.length) : self.navigator.clearAppBadge())).catch(() => {});
      }
    })
  );
});

// The browser rotated this device's subscription: get a new one and tell any open window to register it.
self.addEventListener('pushsubscriptionchange', (e) => {
  const old = e.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  e.waitUntil(
    (key ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : Promise.resolve(null))
      .catch(() => null)
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((list) => list.forEach((c) => c.postMessage({ type: 'lg-resub' })))
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'lg-skip') self.skipWaiting();
});
