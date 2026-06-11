const CACHE_NAME = 'flight-finder-v2';
// Only the icon is precached. The HTML document ('/') is intentionally NOT
// cached: caching it risks serving a stale shell (old bundle refs, old theme)
// after a redeploy. Pages and assets go through the network-first handler below.
const SHELL_URLS = ['/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only cache GET requests for pages and static assets
  if (request.method !== 'GET') return;

  // Skip API routes — always go to network
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache only hashed static assets (immutable across deploys). The HTML
        // document is never cached so a redeploy is picked up on next load.
        if (response.ok && url.pathname.startsWith('/_next/')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
