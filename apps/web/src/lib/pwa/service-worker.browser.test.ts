import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from '../scraper/browser';

const privatePaths = ['/dashboard', '/dashboard?_rsc=fixture', '/api/private', '/_next/image?url=private', '/_next/static/private.js', '/_next/static/no-store.js'];
const bundle = '/_next/static/chunk.js';

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('service worker private data isolation', () => {
  let browser: Browser, origin: string, external: string;
  const servers: Server[] = [];
  beforeAll(async () => {
    const worker = await readFile(new URL('../../../public/sw.js', import.meta.url), 'utf8');
    for (let index = 0; index < 2; index++) {
      const server = createServer((request, response) => {
        const url = new URL(request.url!, 'http://fixture');
        response.setHeader('cache-control', 'no-store');
        response.setHeader('access-control-allow-origin', '*');
        if (url.pathname === '/legacy-sw.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(`self.addEventListener('install', () => self.skipWaiting());
            self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
            self.addEventListener('fetch', event => {
              if (new URL(event.request.url).pathname !== '/_next/image') return;
              event.respondWith(fetch(event.request).then(async response => {
                await (await caches.open('flight-finder-v2')).put(event.request, response.clone());
                return response;
              }));
            });`); return;
        }
        if (url.pathname === '/sw.js') {
          response.setHeader('content-type', 'text/javascript');
          const quota = url.searchParams.has('quota') ? 'Cache.prototype.put = async function() { throw new Error("Fixture storage quota exceeded"); };\n' : '';
          response.end(quota + worker); return;
        }
        if (url.pathname === '/' || url.pathname === '/icon.svg') {
          response.setHeader('content-type', url.pathname === '/' ? 'text/html' : 'image/svg+xml');
          response.end(url.pathname === '/' ? '<h1>Worker fixture</h1>' : '<svg xmlns="http://www.w3.org/2000/svg"/>'); return;
        }
        if (url.pathname === bundle) {
          response.setHeader('cache-control', 'public, max-age=31536000, immutable');
          response.end('Public static bundle'); return;
        }
        if (url.pathname.endsWith('/private.js')) response.setHeader('cache-control', 'private');
        const owner = /(?:^|;\s*)owner=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? 'guest';
        response.end(`Private content for ${owner}`);
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing worker fixture port');
      if (index === 0) origin = `http://127.0.0.1:${address.port}`;
      else external = `http://127.0.0.1:${address.port}`;
    }
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  async function register(page: Page, path = '/sw.js') {
    await page.evaluate(async workerPath => {
      await navigator.serviceWorker.register(workerPath);
      await navigator.serviceWorker.ready;
      const expected = new URL(workerPath, location.href).href;
      if (navigator.serviceWorker.controller?.scriptURL !== expected) await new Promise<void>(resolve => {
        const changed = () => {
          if (navigator.serviceWorker.controller?.scriptURL !== expected) return;
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
          resolve();
        };
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        changed();
      });
      const controller = navigator.serviceWorker.controller!;
      if (controller.state === 'activated') return;
      await new Promise<void>(resolve => {
        const activated = () => {
          if (controller.state !== 'activated') return;
          controller.removeEventListener('statechange', activated);
          resolve();
        };
        controller.addEventListener('statechange', activated);
        activated();
      });
    }, path);
  }
  async function owner(context: BrowserContext, name: string) {
    await context.addCookies([{ name: 'owner', value: name, url: origin }]);
  }
  const fetchText = (page: Page, paths: string[]) => page.evaluate(async urls => Promise.all(urls.map(async url => {
    try { return await (await fetch(url, { cache: 'no-store' })).text(); }
    catch { return 'network unavailable'; }
  })), paths);
  const cachedUrls = (page: Page) => page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat());

  it('never serves another account private content after an account switch or offline transition', async () => {
    const context = await browser.newContext();
    try {
      await owner(context, 'Alice');
      const page = await context.newPage();
      await page.goto(origin);
      await register(page);
      expect(await fetchText(page, privatePaths)).toEqual(privatePaths.map(() => 'Private content for Alice'));
      await owner(context, 'Bob');
      expect(await fetchText(page, privatePaths)).toEqual(privatePaths.map(() => 'Private content for Bob'));
      const cached = await cachedUrls(page);
      for (const path of privatePaths) expect(cached).not.toContain(`${origin}${path}`);
      await context.setOffline(true);
      expect(await fetchText(page, privatePaths)).toEqual(privatePaths.map(() => 'network unavailable'));
    } finally { await context.close(); }
  });

  it('keeps public bundles available offline without caching cross-origin bundles', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await register(page);
      expect(await fetchText(page, [bundle, `${external}${bundle}`])).toEqual(['Public static bundle', 'Public static bundle']);
      await expect.poll(() => cachedUrls(page)).toContain(`${origin}${bundle}`);
      expect(await cachedUrls(page)).not.toContain(`${external}${bundle}`);
      await context.setOffline(true);
      expect(await fetchText(page, [bundle, `${external}${bundle}`])).toEqual(['Public static bundle', 'network unavailable']);
    } finally { await context.close(); }
  });

  it('removes legacy private image entries when the new worker activates', async () => {
    const context = await browser.newContext();
    try {
      await owner(context, 'Alice');
      const page = await context.newPage();
      await page.goto(origin);
      await register(page, '/legacy-sw.js');
      expect(await fetchText(page, ['/_next/image?url=private'])).toEqual(['Private content for Alice']);
      expect(await cachedUrls(page)).toContain(`${origin}/_next/image?url=private`);
      await register(page);
      await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('flight-finder-v2');
      await context.setOffline(true);
      expect(await fetchText(page, ['/_next/image?url=private'])).toEqual(['network unavailable']);
    } finally { await context.close(); }
  });

  it('never reads offline bundles from an unrelated cache', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await register(page);
      await page.evaluate(async path => {
        const cache = await caches.open('fixture-unrelated');
        await cache.put(path, new Response('Unrelated private content'));
      }, bundle);
      await context.setOffline(true);
      expect(await fetchText(page, [bundle])).toEqual(['network unavailable']);
    } finally { await context.close(); }
  });

  it('returns a successful network bundle even when cache storage rejects the write', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await register(page, '/sw.js?quota');
      expect(await fetchText(page, [bundle])).toEqual(['Public static bundle']);
      expect(await cachedUrls(page)).not.toContain(`${origin}${bundle}`);
    } finally { await context.close(); }
  });
});
