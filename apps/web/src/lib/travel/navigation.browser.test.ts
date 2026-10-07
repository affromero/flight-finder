import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchBrowser } from '../scraper/browser';
import { guardTravelNavigation } from './navigation';

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('guarded browser redirects', () => {
  let server: Server;
  let browser: Browser;
  let origin: string;
  let forbiddenRequests = 0;
  let postRedirectDestinations = 0;
  beforeEach(() => { forbiddenRequests = 0; postRedirectDestinations = 0; });
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      if (url.pathname === '/forbidden') forbiddenRequests++;
      if (url.pathname === '/popup') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<form target="_blank" method="${url.searchParams.get('method') ?? 'post'}" action="${url.searchParams.get('action') ?? '/save'}"><input name="consent" value="necessary"><button>Open provider</button></form>`); return;
      }
      if (url.pathname === '/save') {
        response.writeHead(303, { location: '/cookie-result', 'set-cookie': ['consent=necessary; Path=/; HttpOnly', 'second=retained; Path=/'] }); response.end(); return;
      }
      if (url.pathname === '/cookie-result') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<h1>${request.headers.cookie ?? 'missing cookies'}</h1>`); return;
      }
      if (url.pathname === '/post-redirect') {
        response.writeHead(Number(url.searchParams.get('status')), { location: '/post-result' }); response.end(); return;
      }
      if (url.pathname === '/post-result') postRedirectDestinations++;
      if (url.pathname === '/loop') {
        const hop = Number(url.searchParams.get('hop') ?? 0), count = Number(url.searchParams.get('count') ?? 11);
        response.writeHead(302, { location: hop + 1 < count ? `/loop?hop=${hop + 1}&count=${count}` : '/success' }); response.end(); return;
      }
      if (url.pathname === '/embedded') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<h1>Embedded provider content</h1>'); return;
      }
      if (url.pathname === '/with-frame') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<iframe src="/embedded"></iframe><img src="/asset" alt="Provider logo">'); return;
      }
      if (url.pathname === '/asset') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'); return;
      }
      const paths: Record<string, string> = { '/redirect': '/success', '/error-redirect': '/unavailable', '/unsafe': '/forbidden', '/malformed': 'http://[' };
      if (request.url && paths[request.url]) {
        response.writeHead(302, { location: paths[request.url]! }); response.end(); return;
      }
      if (request.url === '/unavailable') {
        setTimeout(() => { response.writeHead(503); response.end('<h1>Rental results</h1><a href="/options?rate_reference=stale">Select car</a>'); }, 100); return;
      }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Rental results</h1>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server port');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const allowed = (url: URL) => url.origin === origin && url.pathname !== '/forbidden';
  it('follows allowed redirects and supports repeated independent navigation', async () => {
    const page = await browser.newPage();
    try {
      const guard = await guardTravelNavigation(page, 'fixture', allowed);
      for (let run = 0; run < 2; run++) {
        guard.reset();
        await page.goto(`${origin}/redirect`);
        await guard.settle();
        expect(await page.locator('h1').textContent()).toBe('Rental results');
        expect(page.url()).toBe(`${origin}/success`);
      }
      await expect(guardTravelNavigation(page, 'different-provider', allowed)).rejects.toThrow(/policy/);
    } finally { await page.close(); }
  });
  it.each(['/unsafe', '/malformed'])('rejects an unsafe redirect without requesting its destination: %s', async path => {
    const page = await browser.newPage();
    try {
      await guardTravelNavigation(page, 'fixture', allowed);
      await expect(page.goto(`${origin}${path}`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      expect(forbiddenRequests).toBe(0);
    } finally { await page.close(); }
  });
  it('rejects a delayed terminal HTTP error even when it contains selectable offer markup', async () => {
    const page = await browser.newPage();
    try {
      const guard = await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/error-redirect`);
      await expect(guard.settle()).rejects.toThrow(/503/);
    } finally { await page.close(); }
  });

  it.each(['get', 'post'])('blocks the first popup %s request before it reaches a forbidden destination', async method => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/popup?action=/forbidden&method=${method}`);
      const failed = context.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/forbidden', timeout: 5000 });
      await page.getByRole('button', { name: 'Open provider' }).click({ noWaitAfter: true });
      expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
      expect(forbiddenRequests).toBe(0);
    } finally { await context.close(); }
  });

  it('retains cookies across a popup form POST and protects its subsequent navigation', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/popup`);
      const opening = context.waitForEvent('page');
      const submission = context.waitForEvent('request', { predicate: request => new URL(request.url()).pathname === '/save' });
      await page.getByRole('button', { name: 'Open provider' }).click();
      expect((await submission).method()).toBe('POST');
      expect((await submission).postData()).toContain('consent=necessary');
      const popup = await opening;
      await popup.waitForURL(`${origin}/cookie-result`);
      const guard = await guardTravelNavigation(popup, 'fixture', allowed);
      await guard.settle();
      expect(await popup.locator('h1').innerText()).toContain('consent=necessary');
      expect(await popup.locator('h1').innerText()).toContain('second=retained');
      guard.reset();
      await expect(popup.goto(`${origin}/unsafe`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      expect(forbiddenRequests).toBe(0);
      await expect(guardTravelNavigation(page, 'different', allowed)).rejects.toThrow(/policy/);
      const sibling = await context.newPage();
      await expect(guardTravelNavigation(sibling, 'different', allowed)).rejects.toThrow(/policy/);
    } finally { await context.close(); }
  });

  it.each([307, 308])('blocks a popup POST redirect with status %s', async status => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/popup?action=${encodeURIComponent(`/post-redirect?status=${status}`)}`);
      const failed = context.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/post-redirect', timeout: 5000 });
      await page.getByRole('button', { name: 'Open provider' }).click({ noWaitAfter: true });
      expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
      expect(postRedirectDestinations).toBe(0);
    } finally { await context.close(); }
  });

  it.each(['/unsafe', '/malformed'])('rejects the first popup redirect before requesting its target: %s', async action => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/popup?action=${action}`);
      const failed = context.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === action, timeout: 5000 });
      await page.getByRole('button', { name: 'Open provider' }).click({ noWaitAfter: true });
      expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
      expect(forbiddenRequests).toBe(0);
    } finally { await context.close(); }
  });

  it('retains the ten-hop limit for an ordinary guarded page and rejects longer chains', async () => {
    const page = await browser.newPage();
    try {
      const guard = await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/loop?count=10`);
      await page.waitForURL(`${origin}/success`);
      await guard.settle();
      guard.reset();
      const failed = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/loop', timeout: 5000 });
      await page.goto(`${origin}/loop?count=11`);
      expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
    } finally { await page.close(); }
  });

  it('bounds a popup redirect loop without changing its parent navigation state', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const guard = await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/popup?action=${encodeURIComponent('/loop?count=11')}`);
      const failed = context.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/loop', timeout: 5000 });
      await page.getByRole('button', { name: 'Open provider' }).click({ noWaitAfter: true });
      expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
      expect(guard.status()).toBe(200);
      await page.goto(`${origin}/redirect`);
      await page.waitForURL(`${origin}/success`);
      await guard.settle();
      expect(await page.locator('h1').innerText()).toBe('Rental results');
    } finally { await context.close(); }
  });

  it('blocks terminal error markup on a popup before a frame can record its status', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await guardTravelNavigation(page, 'fixture', allowed);
      await page.goto(`${origin}/popup?action=/unavailable`);
      const failed = context.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/unavailable', timeout: 5000 });
      await page.getByRole('button', { name: 'Open provider' }).click({ noWaitAfter: true });
      expect((await failed).failure()?.errorText).toMatch(/ERR_FAILED/);
    } finally { await context.close(); }
  });

  it('preserves iframe and subresource loading outside the main navigation policy', async () => {
    const page = await browser.newPage();
    try {
      const policy = (url: URL) => allowed(url) && !['/embedded', '/asset'].includes(url.pathname);
      await guardTravelNavigation(page, 'fixture', policy);
      await page.goto(`${origin}/with-frame`);
      expect(await page.frameLocator('iframe').locator('h1').innerText()).toBe('Embedded provider content');
      expect(await page.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(10);
    } finally { await page.close(); }
  });
});
