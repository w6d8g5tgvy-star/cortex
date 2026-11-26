// Cortex service worker (2.3, offline mode #38). Network first, always: when Cortex is reachable you get live data
// and the newest dashboard. When it isn't, the last copy is shown: the dashboard itself and read-only data
// (projects, tasks, memories list, activity, chats, workflows, notifications). Changes are queued by the page
// (offline-ui.js), never by this worker. Only answers without keys or tokens are cached (an allow-list), and cache
// keys never contain a pairing token.
const CACHE = 'cortex-offline-v1';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/fetcher-ui.js', '/devices-ui.js', '/smartsave-ui.js', '/intel-ui.js', '/workflows-ui.js', '/chat-ui.js', '/files-ui.js', '/offline-ui.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];
// Read-only API answers that are useful offline. Settings, devices, pairing, files and anything else are never cached.
const API_OK = new Set(['/api/state', '/api/item', '/api/activity', '/api/chat', '/api/workflows', '/api/notifications', '/api/timeline', '/api/briefing', '/api/health']);

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k); await self.clients.claim(); })()));

function cacheable(req, url) {
  if (req.method !== 'GET' || url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return API_OK.has(url.pathname);
  return SHELL.includes(url.pathname) || url.pathname.startsWith('/vendor/');
}

async function tell(clientId, offline) { // let the page show or hide its offline banner
  const list = clientId ? [await self.clients.get(clientId)].filter(Boolean) : await self.clients.matchAll();
  for (const c of list) c.postMessage({ cortexOffline: offline });
}

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (!cacheable(req, url)) return; // the browser handles it normally (always network)
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const clean = new URL(url); clean.searchParams.delete('token'); // the key never holds a pairing token
    const key = url.pathname.startsWith('/api/') ? clean.pathname + clean.search : (url.pathname === '/' ? '/index.html' : url.pathname);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone()).catch(() => {});
      if (url.pathname === '/api/state') tell(e.clientId, false);
      return res;
    } catch {
      if (url.pathname.startsWith('/api/')) tell(e.clientId, true);
      const hit = await cache.match(key);
      if (!hit) return new Response(JSON.stringify({ error: 'You are offline and this page has not been saved on this device yet.', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Cortex-Offline': '1' } });
      const h = new Headers(hit.headers); h.set('X-Cortex-Offline', '1');
      return new Response(await hit.blob(), { status: 200, headers: h });
    }
  })());
});
