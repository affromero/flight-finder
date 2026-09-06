import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import pg from 'pg';

// Real pages, login, ownership checks and PostgreSQL. Only stored travel data
// is seeded; no provider requests or live bookings are made by this matrix.
const database = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));
assert.equal(database.pathname, '/hotel_surfaces', 'Use the disposable hotel_surfaces database');
const output = resolve(process.env.TRAVEL_BROWSER_OUTPUT ?? '/tmp/flight-finder-travel-surfaces');
await mkdir(output, { recursive: true });
const db = new pg.Client({ connectionString: database.href });
await db.connect();
assert.equal(Number((await db.query('SELECT count(*) FROM "User"')).rows[0].count), 0, 'Start with an empty test database');
assert.equal(Number((await db.query('SELECT count(*) FROM "Query"')).rows[0].count), 0);
assert.equal(Number((await db.query('SELECT count(*) FROM "HotelTracker"')).rows[0].count), 0);
const servers = [];
const contexts = [];
const passed = [];
const browserErrors = [];
const browser = await chromium.launch({ headless: true, ...(process.env.HOTEL_BROWSER_EXECUTABLE ? { executablePath: process.env.HOTEL_BROWSER_EXECUTABLE } : {}) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const date = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const search = { destination: 'London', dateMode: 'fixed', checkIn: date(45), checkOut: date(48), flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD', sources: ['booking'], filters: { maxTotal: null, refundable: false, breakfast: false, minStars: 0, minRating: 0, excludedSellers: [], amenities: [] } };
const options = { mode: 'best', targetPrice: null, notifyLows: true, allowApproximateAlerts: false, scrapeInterval: 3 };

async function startServer(name, port, selfHosted) {
  const log = createWriteStream(resolve(output, `${name}-server.log`));
  const child = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: resolve('apps/web'),
    env: { ...process.env, SELF_HOSTED: String(selfHosted), CRON_ENABLED: 'false', REDIS_URL: '', FF_ACCESS_PASSWORD: '', FF_MACHINE_TOKEN: '', ADMIN_SESSION_SECRET: 'travel-surface-test-only-session-secret', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log); child.stderr.pipe(log);
  servers.push({ child, log });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(child.exitCode, null, `${name} server exited; see its log`);
    const response = await fetch(`${url}/api/health`).catch(() => null);
    if (response?.ok) return url;
    await delay(500);
  }
  throw new Error(`${name} server did not become healthy`);
}

async function context(url, locale = 'en') {
  const ctx = await browser.newContext({ baseURL: url, viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await ctx.addCookies([{ name: 'ft-locale', value: locale, url }]);
  contexts.push(ctx);
  return ctx;
}

async function pageFor(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => browserErrors.push(error.message));
  return page;
}

async function messages(locale) {
  const pages = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/pages.json`), 'utf8'));
  const components = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/components.json`), 'utf8'));
  const hotels = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/hotels.json`), 'utf8'));
  return { ...pages, ...components, ...hotels };
}

async function capture(page, name) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no page-wide horizontal overflow at ${width}px`);
    await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true, animations: 'disabled' });
  }
}

function pass(name) { passed.push(name); console.log(`PASS ${name}`); }

async function json(response, status = 200) {
  assert.equal(response.status(), status, await response.text());
  return (await response.json()).data;
}

async function seedTravel(user, kind) {
  const hotelId = `surface-hotel-${kind}`;
  const flightId = `surface-flight-${kind}`;
  if (kind !== 'hotels') await db.query(`INSERT INTO "Query" (id,"userId","rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt",active,"firstViewedAt","updatedAt") VALUES ($1,$2,'Surface test flight','LHR','London','JFK','New York',$3,$4,$3,false,now(),now())`, [flightId, user.id, search.checkIn, search.checkOut]);
  if (kind !== 'flights') {
    const selection = { propertyId: hotelId, source: 'booking', hotelName: kind === 'hotels' ? 'Bloomsbury Hotel' : 'Riverside Hotel', propertyUrl: 'https://www.booking.com/hotel/gb/park.html', roomName: null, rateName: null, seller: 'Booking.com', refundable: null, breakfast: null };
    await db.query(`INSERT INTO "HotelTracker" (id,"userId","hotelName",search,selection,options,active,"updatedAt") VALUES ($1,$2,$3,$4,$5,$6,false,now())`, [hotelId, user.id, selection.hotelName, search, selection, options]);
  }
  return { hotelId, flightId };
}

try {
  await db.query(`INSERT INTO "ExtractionConfig" (id,"adminPasswordHash",enabled,"updatedAt") VALUES ('singleton','self-hosted',false,now())`);
  const publicUrl = await startServer('public', 3015, false);
  const privateUrl = await startServer('private', 3016, true);
  for (const locale of ['en', 'es', 'pt', 'de', 'fr']) {
    const t = await messages(locale);
    const ctx = await context(publicUrl, locale);
    const page = await pageFor(ctx);
    await page.goto('/');
    await page.getByRole('heading', { name: t.Landing.travelTitle, exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
    assert.ok((await page.locator('main').innerText()).includes(t.Landing.travelIntro));
    assert.ok((await page.locator('main').innerText()).includes(t.Landing.travelHousehold));
    assert.ok((await page.locator('main').innerText()).includes(t.Landing.travelAvailability));
    assert.equal(await page.locator('a[href="/hotels"]').count(), 0, 'Public visitors install rather than navigate to a disabled search');
    assert.match(await page.locator('meta[name="description"]').getAttribute('content'), /flight and hotel/i);
    assert.match(await page.locator('meta[property="og:description"]').getAttribute('content'), /flight and hotel/i);
    const structured = JSON.parse(await page.locator('script[type="application/ld+json"]').innerText());
    assert.match(structured.description, /flight and hotel/i);
    assert.match(await page.title(), /flight and hotel/i);
    const manifest = await (await ctx.request.get('/manifest.json')).json();
    assert.match(manifest.description, /flight and hotel/i);
    await capture(page, `public-${locale}`);
    assert.equal((await ctx.request.get('/hotels')).status(), 404);
    assert.equal((await ctx.request.get('/api/hotels')).status(), 404);
    await page.getByRole('link', { name: t.InstallCommand.desktopLink }).click();
    await page.getByRole('heading', { name: t.Download.title }).waitFor();
    assert.ok((await page.locator('main').innerText()).includes(t.Download.subtitle));
    pass(`public-${locale}: product, metadata, mobile, install link and hotel access boundary`);
  }

  const solo = await context(privateUrl);
  const soloPage = await pageFor(solo);
  await soloPage.goto('/');
  await soloPage.getByRole('link', { name: 'Hotels', exact: true }).waitFor();
  await soloPage.getByRole('heading', { name: 'Saved hotels' }).waitFor();
  assert.match(await soloPage.locator('main').innerText(), /No flight trackers yet/);
  assert.equal(await soloPage.locator('#travel-title').count(), 0, 'Public marketing does not replace the private search');
  await capture(soloPage, 'private-solo');
  await soloPage.getByRole('link', { name: 'Hotels', exact: true }).click();
  await soloPage.getByLabel('City or hotel name').waitFor();
  pass('private solo: both travel sections without creating a flight');

  await json(await solo.request.post('/api/admin/multi-user', { data: { adminUsername: 'surface-admin' } }), 201);
  await json(await solo.request.post('/api/auth/login', { data: { username: 'surface-admin' } }));
  const users = [];
  for (const kind of ['flights', 'hotels', 'both']) {
    const displayName = { flights: 'Alex Rivera', hotels: 'Maya Torres', both: 'Jamie Chen' }[kind];
    const { user } = await json(await solo.request.post('/api/admin/users', { data: { username: `surface-${kind}`, displayName } }), 201);
    users.push({ user, kind, ...await seedTravel(user, kind) });
  }

  const anonymous = await context(privateUrl);
  const anonymousPage = await pageFor(anonymous);
  await anonymousPage.goto('/hotels');
  assert.equal(new URL(anonymousPage.url()).pathname, '/login');
  assert.equal((await anonymous.request.get('/api/hotels')).status(), 401);
  const publicAfterHousehold = await context(publicUrl);
  assert.equal((await publicAfterHousehold.request.get('/')).status(), 200);
  assert.equal((await publicAfterHousehold.request.get('/hotels')).status(), 404);
  pass('household login and public isolation');

  for (const member of users) {
    for (const locale of member.kind === 'hotels' ? ['en', 'es', 'pt', 'de', 'fr'] : ['en']) {
      const t = await messages(locale);
      const ctx = await context(privateUrl, locale);
      await json(await ctx.request.post('/api/auth/login', { data: { username: member.user.username } }));
      const page = await pageFor(ctx);
      await page.goto('/account');
      await page.getByRole('heading', { name: t.Account.yourTrackers, exact: true }).waitFor();
      await page.getByRole('heading', { name: t.Hotels.saved, exact: true }).waitFor();
      if (member.kind !== 'flights') await page.locator(`a[href="/hotels/${member.hotelId}"]`).waitFor();
      if (member.kind !== 'hotels') await page.locator(`a[href="/q/${member.flightId}"]`).waitFor();
      if (member.kind === 'hotels') assert.ok((await page.locator('main').innerText()).includes(t.Account.empty.replace(/<\/?link>/g, '')));
      const hotelData = await json(await ctx.request.get('/api/hotels'));
      const flightData = await json(await ctx.request.get('/api/queries/active'));
      assert.deepEqual(hotelData.trackers.map(tracker => tracker.id), member.kind === 'flights' ? [] : [member.hotelId]);
      assert.deepEqual(flightData.queries.map(query => query.id), member.kind === 'hotels' ? [] : [member.flightId]);
      const other = users.find(user => user.kind !== 'flights' && user.kind !== member.kind);
      assert.equal((await ctx.request.get(`/api/hotels/${other.hotelId}`)).status(), 404, 'Another member’s hotel is not accessible');
      assert.equal((await ctx.request.get('/api/hotels?admin=true')).status(), 403);
      await capture(page, `account-${member.kind}-${locale}`);
      await page.getByRole('link', { name: t.Hotels.hotels, exact: true }).click();
      await page.getByRole('button', { name: t.Hotels.search, exact: true }).waitFor();
      await page.getByRole('link', { name: t.Hotels.flights, exact: true }).click();
      if (member.kind === 'hotels') await page.getByText(t.SavedTrackers.noTrackers, { exact: true }).waitFor();
      if (member.kind !== 'flights') await page.locator(`a[href="/hotels/${member.hotelId}"]`).waitFor();
      pass(`household-${member.kind}-${locale}: owned trackers, navigation and mobile`);
    }
  }
  assert.deepEqual(browserErrors, [], 'No browser exceptions');
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed, browserErrors }, null, 2));
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ passed, error: String(error), browserErrors }, null, 2));
  throw error;
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
  for (const { child, log } of servers) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    log.end();
  }
  await db.end();
}
