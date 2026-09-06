import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// HTTP fixtures exercise the actual production UI. Only validation reaches the
// disposable backend; this harness never starts live provider scrapes.
const server = process.env.HOTEL_BROWSER_URL ?? 'http://127.0.0.1:3014';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(server).hostname), 'Use an isolated local test server');
const output = resolve(process.env.HOTEL_BROWSER_OUTPUT ?? '/tmp/flight-finder-hotel-browser');
await mkdir(output, { recursive: true });
const date = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const search = {
  destination: 'Park Hotel', dateMode: 'fixed', checkIn: date(45), checkOut: date(48),
  flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD',
  sources: ['google_hotels', 'booking'],
  filters: { maxTotal: null, refundable: false, breakfast: false, minStars: 0, minRating: 0, excludedSellers: [], amenities: [] },
};
const offer = {
  id: 'verified-offer', source: 'booking', propertyId: 'park', providerRateId: 'double-breakfast', hotelName: 'Park Hotel',
  address: 'London', imageUrl: null, propertyUrl: 'https://www.booking.com/hotel/gb/park.html',
  bookingUrl: 'https://www.booking.com/hotel/gb/park.html', seller: 'Booking.com',
  roomName: 'Deluxe double room', rateName: 'Breakfast included', totalPrice: 647,
  currency: 'USD', taxesIncluded: true, occupancyVerified: true, checkIn: search.checkIn,
  checkOut: search.checkOut, rooms: search.rooms, refundable: true, breakfast: true,
  stars: 4, rating: 8.6, amenities: {}, match: 'exact',
};
const browser = await chromium.launch({ headless: true, ...(process.env.HOTEL_BROWSER_EXECUTABLE ? { executablePath: process.env.HOTEL_BROWSER_EXECUTABLE } : {}) });
const passed = [];

async function scenario(name, test, { real = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const requests = [];
  const state = { status: 'success', interrupted: false, empty: false };
  const tracker = {
    id: 'browser-tracker', hotelName: offer.hotelName, search, selection: offer,
    options: { mode: 'best', targetPrice: 700, notifyLows: true, allowApproximateAlerts: false, scrapeInterval: 3 },
    active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(), lastError: null, latestPrice: 647, currency: 'USD',
  };
  const snapshots = [647, 690, 735].map((price, index) => ({
    id: `snapshot-${index}`, runId: `run-${index}`, scrapedAt: new Date(Date.now() - index * 86400000).toISOString(),
    eligible: true, offer: { ...offer, totalPrice: price },
  }));
  page.on('pageerror', error => errors.push(error.message));
  if (!real) await page.route('**/api/hotels**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = req.postData() ? req.postDataJSON() : undefined;
    requests.push({ path, method, body });
    const ok = data => route.fulfill({ json: { ok: true, data } });
    const result = {
      offers: state.empty ? [] : [offer], completed: state.status === 'running' ? 1 : 2, total: 2,
      errors: state.status === 'partial' ? [{ source: 'google_hotels', checkIn: search.checkIn, checkOut: search.checkOut, message: 'Google Hotels could not verify taxes for this stay.' }] : [],
    };
    if (path === '/api/hotels/search' && method === 'POST') return ok({ id: 'browser-job', status: 'queued' });
    if (path === '/api/hotels/search/browser-job' && method === 'DELETE') { state.status = 'cancelled'; return ok({ id: 'browser-job', status: 'cancelled' }); }
    if (path === '/api/hotels/search/browser-job' && method === 'GET') {
      if (state.interrupted) return route.fulfill({ status: 503, json: { ok: false, error: 'Connection interrupted while checking hotel prices.' } });
      return ok({ id: 'browser-job', status: state.status, result, error: null });
    }
    if (path === '/api/hotels' && method === 'GET') return ok({ trackers: [] });
    if (path === '/api/hotels' && method === 'POST') return ok({ tracker });
    if (path === '/api/hotels/browser-tracker' && method === 'PATCH') { Object.assign(tracker, body); return ok({ tracker }); }
    if (path === '/api/hotels/browser-tracker' && method === 'GET') return ok({ tracker, snapshots, runs: [], notificationsConfigured: true });
    errors.push(`Unexpected hotel request: ${method} ${path}`);
    return route.fulfill({ status: 500, json: { ok: false, error: 'Unexpected test request' } });
  });
  async function fill() {
    await page.goto(`${server}/hotels`);
    await page.getByLabel('City or hotel name').fill(search.destination);
    await page.getByLabel('Check-in', { exact: true }).fill(search.checkIn);
    await page.getByLabel('Check-out', { exact: true }).fill(search.checkOut);
  }
  async function start() {
    await fill();
    await page.getByRole('button', { name: 'Search hotels', exact: true }).click();
  }
  async function capture() { await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true, animations: 'disabled' }); }
  try {
    await test({ page, state, requests, fill, start, capture });
    assert.deepEqual(errors, [], 'No browser exceptions or unexpected requests');
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    await capture().catch(() => undefined);
    await writeFile(resolve(output, 'failure.json'), JSON.stringify({ scenario: name, passed, error: String(error), browserErrors: errors, requests }, null, 2));
    throw error;
  } finally { await context.close(); }
}

try {
  await scenario('family-and-navigation', async ({ page, fill, requests, state, capture }) => {
    state.empty = true;
    await fill();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const brand = page.getByRole('link', { name: /Flight Finder home/i });
      const homeBox = await brand.boundingBox();
      const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
      assert.ok(homeBox && heading && homeBox.y + homeBox.height <= heading.y, 'Home link does not cover hotel heading');
      const navigation = await page.getByRole('link', { name: 'Hotels', exact: true }).boundingBox();
      assert.ok(navigation && homeBox.y + homeBox.height <= navigation.y, 'Home link does not cover hotel navigation');
      const before = homeBox.y;
      await page.evaluate(() => window.scrollTo(0, 150));
      assert.ok((await brand.boundingBox()).y < before - 50, 'Hotel branding scrolls with content');
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await page.getByRole('button', { name: 'Add room', exact: true }).click();
    await page.getByLabel('Children', { exact: true }).nth(1).fill('1');
    await page.getByLabel('Room 2, child 1: age').fill('6');
    await page.getByText(/Google Hotels supports one room/).waitFor();
    await capture();
    await page.getByRole('checkbox', { name: 'Google Hotels', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Search hotels', exact: true }).click();
    await page.getByRole('region', { name: 'Available offers' }).waitFor();
    const submitted = requests.find(req => req.method === 'POST' && req.path === '/api/hotels/search');
    assert.deepEqual(submitted.body.rooms, [{ adults: 2, children: [] }, { adults: 2, children: [6] }]);
    assert.deepEqual(submitted.body.sources, ['booking']);
  });
  await scenario('completed-offer-tracking', async ({ page, start, requests, capture }) => {
    await start();
    await page.getByRole('button', { name: 'Track this hotel' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Track this hotel' }).isEnabled(), true);
    await capture();
    await page.getByRole('button', { name: 'Track this hotel' }).click();
    await page.waitForURL('**/hotels/browser-tracker');
    assert.ok(requests.some(req => req.method === 'POST' && req.path === '/api/hotels' && req.body.searchId === 'browser-job' && req.body.offerId === offer.id));
    await page.getByRole('heading', { name: offer.hotelName, exact: true }).waitFor();
  });
  await scenario('partial-provider-error', async ({ page, state, start, capture }) => {
    state.status = 'partial';
    await start();
    await page.locator('p[role="alert"]').filter({ hasText: /verify taxes/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Track this hotel' }).isEnabled(), true);
    await capture();
  });
  await scenario('progress-and-recovery', async ({ page, state, start, requests, capture }) => {
    state.status = 'running';
    await start();
    await page.getByRole('button', { name: 'Track this hotel' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Track this hotel' }).isDisabled(), true);
    state.interrupted = true;
    await page.getByRole('button', { name: 'Retry status updates' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel search', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Track this hotel' }).isDisabled(), true);
    await capture();
    state.interrupted = false; state.status = 'success';
    await page.getByRole('button', { name: 'Retry status updates' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Track this hotel' && !button.disabled));
    assert.equal(requests.filter(req => req.path === '/api/hotels/search' && req.method === 'POST').length, 1, 'Retry resumes the existing job, not a new search');
  });
  await scenario('cancel-search', async ({ page, state, start, requests, capture }) => {
    state.status = 'running';
    await start();
    await page.getByRole('button', { name: 'Cancel search', exact: true }).click();
    await page.getByText(/Search cancelled/).waitFor();
    assert.ok(requests.some(req => req.path === '/api/hotels/search/browser-job' && req.method === 'DELETE'));
    assert.equal(await page.getByRole('button', { name: 'Search hotels', exact: true }).isEnabled(), true);
    await capture();
  });
  await scenario('mobile-history-and-pause', async ({ page, requests, capture }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`${server}/hotels/browser-tracker`);
    const region = page.getByRole('region', { name: 'Detailed price history' });
    await region.waitFor();
    await page.getByRole('img', { name: 'Price history', exact: true }).waitFor();
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[aria-label="Detailed price history"]').scrollLeft > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Check prices now' }).isDisabled(), true);
    assert.ok(requests.some(req => req.method === 'PATCH' && req.body.active === false));
    await capture();
  });
  await scenario('backend-search-limit', async ({ page, fill, capture }) => {
    await fill();
    await page.getByRole('combobox').filter({ has: page.locator('option[value="nearby"]') }).selectOption('nearby');
    await page.getByLabel('Days either side', { exact: true }).fill('3');
    const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/hotels/search' && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Search hotels', exact: true }).click();
    assert.equal((await response).status(), 400);
    await page.locator('p[role="alert"]').filter({ hasText: /24 date\/source combinations/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Search hotels', exact: true }).isEnabled(), true);
    await capture();
  }, { real: true });
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed, fixtures: true, validation: 'real backend' }, null, 2));
} finally { await browser.close(); }
