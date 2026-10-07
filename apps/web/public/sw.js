const CACHE_NAME = 'flight-finder-v3';
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

  // Private pages, RSC payloads, APIs and optimized images stay on the network.
  // Only same-origin public static bundles are eligible for offline storage.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/_next/static/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache only hashed static assets (immutable across deploys). The HTML
        // document is never cached so a redeploy is picked up on next load.
        if (response.ok && response.type === 'basic' && !/private|no-store/i.test(response.headers.get('cache-control') || '')) {
          const clone = response.clone();
          // Storage failures must not discard a successful network response.
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {}));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (!cached || cached.type !== 'basic' || /private|no-store/i.test(cached.headers.get('cache-control') || '')) throw new Error('Static asset unavailable');
        return cached;
      })
  );
});
