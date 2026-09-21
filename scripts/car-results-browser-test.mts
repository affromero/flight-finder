import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import pg from 'pg';
import { carOfferFixture, carReportFixture, carSearchFixture } from '../apps/web/src/test/car-fixtures';
import { carContractHash } from '../apps/web/src/lib/cars/selection';
import { carEstimatedExtrasBrowserScenario, carProtectionBrowserScenarios } from './car-protection-browser-scenarios.mts';
import { travelRecoveryBrowserScenarios } from './travel-recovery-browser-scenarios.mts';

// Disposable stored observations exercise real pages and authentication. No
// provider browser is started and all scheduled background work is disabled.
const database = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55440');
assert.equal(database.pathname, '/car_results_browser', 'Use the dedicated disposable browser database');
const output = resolve(process.env.CAR_BROWSER_OUTPUT ?? '/tmp/flight-finder-car-results-browser');
await mkdir(output, { recursive: true });
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
let connected = false, seeded = false, browser: Browser | undefined;
const servers: { child: ReturnType<typeof spawn>; log: ReturnType<typeof createWriteStream> }[] = [];
const contexts: BrowserContext[] = [], passed: string[] = [], errors: string[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const search = carSearchFixture(), report = carReportFixture(), now = new Date().toISOString();
search.pickup.providerNames = { discovercars: 'London Heathrow Airport terminal collection area', autoeurope: 'London Heathrow Airport rental search area' };
search.dropoff.providerNames = { discovercars: 'London Heathrow Airport return area', autoeurope: 'London Heathrow Airport vehicle return area' };
async function start(name: string, port: number, selfHosted: boolean) {
  const log = createWriteStream(resolve(output, `${name}.log`));
  const child = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: resolve('apps/web'), env: { ...process.env, SELF_HOSTED: String(selfHosted), CRON_ENABLED: 'false', REDIS_URL: '', ADMIN_SESSION_SECRET: 'car-results-disposable-test-secret', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log); child.stderr?.pipe(log); servers.push({ child, log });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(child.exitCode, null, `${name} exited; inspect ${output}/${name}.log`);
    if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok) return url;
    await delay(500);
  }
  throw new Error(`${name} did not start`);
}
async function context(url: string, locale = 'en') {
  assert.ok(browser);
  const ctx = await browser.newContext({ baseURL: url, viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  ctx.setDefaultTimeout(15_000); ctx.setDefaultNavigationTimeout(20_000);
  contexts.push(ctx); await ctx.addCookies([{ name: 'ft-locale', value: locale, url }]);
  await ctx.route('**/*', route => {
    const target = new URL(route.request().url());
    return target.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return ctx;
}
async function login(ctx: BrowserContext, username: string) {
  const response = await ctx.request.post('/api/auth/login', { data: { username } });
  assert.equal(response.status(), 200, await response.text());
}
try {
  await db.connect(); connected = true;
  for (const table of ['User', 'Query', 'HotelTracker', 'CarTracker', 'CarSearchRun', 'ExtractionConfig']) {
    assert.equal(Number((await db.query(`SELECT count(*) FROM "${table}"`)).rows[0].count), 0, `Start with an empty ${table}`);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  seeded = true;
  await db.query(`INSERT INTO "ExtractionConfig" (id,"setupComplete",enabled,"multiUserMode","updatedAt") VALUES ('singleton',true,false,true,now())`);
  for (const name of ['alice', 'bob']) await db.query(`INSERT INTO "User" (id,username,"updatedAt") VALUES ($1,$1,now())`, [`car-browser-${name}`]);
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId",request,result,status,"createdAt","completedAt") VALUES ('car-browser-search','car-browser-alice',$1,$2,'success',$3,$3)`, [search, report, now]);
  const privateUrl = await start('private', 3017, true), publicUrl = await start('public', 3018, false);
  const alice = await context(privateUrl); await login(alice, 'car-browser-alice');
  const draftPage = await alice.newPage(); await draftPage.setViewportSize({ width: 390, height: 1000 }); await draftPage.goto('/cars');
  let draftFailure = false;
  await draftPage.route('**/api/cars/parse', route => route.fulfill({ status: draftFailure ? 503 : 200, contentType: 'application/json', body: JSON.stringify(draftFailure ? { ok: false, error: 'Injected provider failure' } : { ok: true, data: { draft: { pickupQuery: 'London', additionalDrivers: [{}], filters: { transmission: 'automatic' }, warnings: ['Cross-border permission must be confirmed separately.'] } } }) }));
  await draftPage.getByLabel('Age at pickup', { exact: true }).fill('42');
  await draftPage.getByLabel('Rental description', { exact: true }).fill('Automatic rental in London with an additional driver and cross-border travel');
  await draftPage.getByRole('button', { name: 'Prepare draft', exact: true }).click();
  await draftPage.getByRole('button', { name: 'Review draft in form', exact: true }).click();
  assert.equal(await draftPage.getByRole('combobox', { name: 'Pickup city or airport' }).inputValue(), 'London');
  assert.equal(await draftPage.getByLabel('Age at pickup', { exact: true }).first().inputValue(), '42');
  assert.equal(await draftPage.getByLabel('Age at pickup', { exact: true }).nth(1).inputValue(), '');
  assert.ok(await draftPage.getByRole('button', { name: 'Check rental prices', exact: true }).isDisabled());
  await draftPage.getByText('Vehicle filters and extras', { exact: true }).click();
  assert.ok(await draftPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await draftPage.screenshot({ path: resolve(output, 'draft-review-fixture-390.png'), fullPage: true });
  draftFailure = true;
  await draftPage.getByRole('button', { name: 'Prepare draft', exact: true }).click();
  await draftPage.getByRole('alert').filter({ hasText: 'The draft could not be prepared' }).waitFor();
  assert.equal(await draftPage.getByLabel('Age at pickup', { exact: true }).first().inputValue(), '42');
  await draftPage.screenshot({ path: resolve(output, 'draft-error-fixture-390.png'), fullPage: true });
  await draftPage.close();
  passed.push('Injected AI draft review and provider error: unknown additional driver preserved, manual age unchanged, explicit review required, mobile layout without overflow');
  const formPage = await alice.newPage(); await formPage.goto('/cars');
  await formPage.getByRole('heading', { name: 'Find your rental', exact: true }).waitFor();
  assert.equal(await formPage.getByLabel('Age at pickup', { exact: true }).inputValue(), '');
  assert.equal(await formPage.getByRole('combobox', { name: /^Country of residence/ }).inputValue(), '');
  await formPage.getByRole('combobox', { name: 'Pickup city or airport' }).fill('LHR');
  await formPage.getByRole('option', { name: /LHR · London Heathrow Airport/ }).click();
  const rentalYear = new Date().getUTCFullYear() + 1;
  await formPage.getByLabel('Pickup date', { exact: true }).fill(`${rentalYear}-01-15`);
  await formPage.getByLabel('Return date', { exact: true }).fill(`${rentalYear}-01-18`);
  for (const field of await formPage.getByLabel('Local time', { exact: true }).all()) await field.fill('11:00');
  await formPage.getByLabel('Age at pickup', { exact: true }).fill('35');
  await formPage.getByLabel('Full years holding a licence', { exact: true }).fill('5');
  await formPage.getByRole('combobox', { name: /^Country of residence/ }).selectOption('GB');
  for (const width of [1280, 390]) {
    await formPage.setViewportSize({ width, height: 1000 });
    assert.ok(await formPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await formPage.screenshot({ path: resolve(output, `search-form-${width}.png`), fullPage: true });
  }
  await formPage.getByText('Vehicle filters and extras', { exact: true }).click();
  await formPage.getByLabel('Child seat', { exact: true }).fill('2');
  await formPage.getByRole('button', { name: 'Add driver', exact: true }).click();
  await formPage.getByLabel('Age at pickup', { exact: true }).nth(1).fill('23');
  await formPage.getByLabel('Full years holding a licence', { exact: true }).nth(1).fill('2');
  await formPage.getByRole('combobox', { name: /^Country of residence/ }).nth(1).selectOption('GB');
  await formPage.screenshot({ path: resolve(output, 'search-extras-390.png'), fullPage: true });
  let creationKey: string | undefined;
  await formPage.route('**/api/cars/search', async route => {
    creationKey = route.request().headers()['idempotency-key'];
    const accepted = await route.fetch();
    assert.equal(accepted.status(), 202, await accepted.text());
    await route.abort();
  });
  await formPage.getByRole('button', { name: 'Check rental prices', exact: true }).click();
  await formPage.getByRole('button', { name: 'Recover this search', exact: true }).waitFor();
  assert.ok(await formPage.getByRole('button', { name: 'Check rental prices', exact: true }).isDisabled());
  await formPage.screenshot({ path: resolve(output, 'search-lost-ack-390.png'), fullPage: true });
  await formPage.unroute('**/api/cars/search');
  await formPage.reload();
  await formPage.getByRole('button', { name: 'Recover this search', exact: true }).click();
  const openSearch = formPage.getByRole('link', { name: 'Open rental search', exact: true });
  await openSearch.waitFor();
  const createdId = (await openSearch.getAttribute('href'))!.split('/').at(-1)!;
  assert.ok(creationKey);
  const created = (await db.query(`SELECT request FROM "CarSearchRun" WHERE id=$1`, [createdId])).rows[0].request;
  assert.deepEqual(created.pickup.providerIds, {});
  assert.deepEqual(created.extras.childSeats, [{ category: 'child', quantity: 2 }]);
  assert.deepEqual(created.extras.additionalDrivers, [{ age: 23, licenceYears: 2, residenceCountry: 'GB' }]);
  assert.equal(Number((await db.query(`SELECT count(*) FROM "CarSearchCreation" WHERE "userId"='car-browser-alice'`)).rows[0].count), 1);
  await openSearch.click();
  await formPage.getByRole('button', { name: 'Cancel search', exact: true }).click();
  await formPage.getByRole('status').filter({ hasText: 'Cancelled' }).waitFor();
  assert.equal((await db.query(`SELECT status FROM "CarSearchRun" WHERE id=$1`, [createdId])).rows[0].status, 'cancelled');
  await formPage.screenshot({ path: resolve(output, 'catalog-search-cancelled-390.png'), fullPage: true });
  for (const locale of ['es', 'fr', 'de', 'pt']) {
    const copy = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/cars.json`), 'utf8')).Cars.Search;
    const localized = await context(privateUrl, locale); await login(localized, 'car-browser-alice');
    const localizedPage = await localized.newPage(); await localizedPage.setViewportSize({ width: 390, height: 1000 }); await localizedPage.goto('/cars');
    await localizedPage.getByRole('heading', { name: copy.findCar, exact: true }).waitFor();
    assert.ok(await localizedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await localizedPage.screenshot({ path: resolve(output, `search-form-${locale}-390.png`), fullPage: true });
  }
  assert.equal((await alice.request.get('/api/cars/locations?q=LHR')).status(), 200);
  assert.equal((await fetch(`${publicUrl}/api/cars/locations?q=LHR`)).status, 404);
  assert.equal((await fetch(`${privateUrl}/api/cars/locations?q=LHR`)).status, 401);
  const attribution = await fetch(`${publicUrl}/cars/location-data`);
  assert.equal(attribution.status, 200); assert.match(await attribution.text(), /GeoNames/);
  passed.push('Five-locale independent catalog form, driver and extra requirements, durable lost-ack recovery, real queued cancellation and location access boundaries');
  const page = await alice.newPage(); await page.goto('/cars/search/car-browser-search');
  await page.getByRole('button', { name: 'Track this rental' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Track this rental' }).isEnabled());
  await page.getByText('DiscoverCars search location: London Heathrow Airport terminal collection area', { exact: true }).waitFor();
  await page.getByText('DiscoverCars search location: London Heathrow Airport return area', { exact: true }).waitFor();
  assert.equal(await page.getByText('Auto Europe search location: London Heathrow Airport rental search area', { exact: true }).count(), 0);
  assert.equal(await page.locator('h1').count(), 1);
  assert.match(await page.locator('meta[name="robots"]').getAttribute('content') ?? '', /noindex/);
  await page.getByText('Charges, extras and rental conditions', { exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.ok(await page.getByRole('heading', { name: 'Itemized charges' }).isVisible());
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No overflow at ${width}`);
    const brand = await page.locator('a[aria-label="Flight Finder home"]').boundingBox(), heading = await page.locator('h1').boundingBox();
    assert.ok(brand && heading && brand.y + brand.height <= heading.y, 'Home link does not overlap the result heading');
    await page.screenshot({ path: resolve(output, `verified-${width}.png`), fullPage: true });
  }
  passed.push('Owned verified results, evidence, desktop/mobile layout and noindex');
  for (const locale of ['es', 'fr', 'de', 'pt']) {
    const copy = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/cars.json`), 'utf8')).Cars;
    const localized = await context(privateUrl, locale); await login(localized, 'car-browser-alice');
    const localizedPage = await localized.newPage(); await localizedPage.goto('/cars/search/car-browser-search');
    await localizedPage.getByRole('heading', { level: 1, name: copy.searchTitle }).waitFor();
    assert.ok(await localizedPage.getByRole('button', { name: copy.track, exact: true }).isEnabled());
    await localizedPage.setViewportSize({ width: 390, height: 1000 });
    assert.ok(await localizedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await localizedPage.screenshot({ path: resolve(output, `verified-${locale}-390.png`), fullPage: true });
  }
  passed.push('Five locale result controls and keyboard evidence disclosure');
  await carProtectionBrowserScenarios(db, alice, output);
  await carEstimatedExtrasBrowserScenario(db, alice, output);
  passed.push('Selected extras survive protection creation; estimate and surcharge warnings remain visible in both themes and screen sizes; API and UI reject tracking');
  passed.push('Protection options in both themes and responsive layouts, explicit terms review, lost real acknowledgement recovery, web and built CLI protected tracking with review required, and permanent parent closure preserving accepted child searches');
  await page.route('**/api/cars/search/car-browser-search', route => route.abort());
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('alert').filter({ hasText: 'Status updates interrupted' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Track this rental' }).isDisabled());
  await page.screenshot({ path: resolve(output, 'interrupted-390.png'), fullPage: true });
  await page.unroute('**/api/cars/search/car-browser-search');
  await page.getByRole('button', { name: 'Retry status updates' }).click();
  await page.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
  passed.push('Real browser transport interruption makes results read-only and explicit retry restores them');
  const bob = await context(privateUrl); await login(bob, 'car-browser-bob');
  assert.equal((await bob.request.get('/cars/search/car-browser-search')).status(), 404);
  assert.equal((await bob.request.get('/api/cars/search/car-browser-search')).status(), 404);
  const publicCtx = await context(publicUrl);
  assert.equal((await publicCtx.request.get('/cars/search/car-browser-search')).status(), 404);
  assert.equal((await publicCtx.request.get('/api/cars/search/car-browser-search')).status(), 404);
  const anonymous = await context(privateUrl), anonymousPage = await anonymous.newPage();
  await anonymousPage.goto('/cars/search/car-browser-search'); assert.equal(new URL(anonymousPage.url()).pathname, '/login');
  passed.push('Foreign account and public instance return 404; anonymous private visitor signs in');
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId",request,result,status,"createdAt","completedAt") VALUES ('car-browser-close','car-browser-alice',$1,$2,'success',$3,$3)`, [search, report, now]);
  const closureUrl = '/api/cars/search/car-browser-close/close-tracking';
  assert.equal((await bob.request.post(closureUrl)).status(), 404);
  assert.equal((await publicCtx.request.post(closureUrl)).status(), 404);
  assert.equal((await anonymous.request.post(closureUrl)).status(), 401);
  const savedKey = crypto.randomUUID(), savedBody = { searchId: 'car-browser-close', offerId: 'verified-quote' };
  const savedResponse = await alice.request.post('/api/cars', { headers: { 'Idempotency-Key': savedKey }, data: savedBody });
  assert.equal(savedResponse.status(), 201, await savedResponse.text());
  const savedTracker = (await savedResponse.json()).data.tracker;
  const recoveryPage = await alice.newPage(); await recoveryPage.setViewportSize({ width: 390, height: 1000 });
  await recoveryPage.goto('/cars/search/car-browser-close');
  await recoveryPage.evaluate(() => sessionStorage.setItem('ff-car-creation:car-browser-alice:car-browser-close', '{broken'));
  await recoveryPage.reload();
  assert.ok(await recoveryPage.getByRole('button', { name: 'Track this rental' }).isDisabled());
  await recoveryPage.getByText('Close tracking from this search', { exact: true }).focus(); await recoveryPage.keyboard.press('Enter');
  await recoveryPage.getByText('Close tracking from this search', { exact: true }).scrollIntoViewIfNeeded();
  await recoveryPage.getByText('Close tracking from this search', { exact: true }).locator('..').screenshot({ path: resolve(output, 'creation-corrupt-confirm-390.png') });
  await recoveryPage.route(`**${closureUrl}`, async route => {
    const accepted = await route.fetch(); assert.equal(accepted.status(), 200, await accepted.text());
    await route.abort();
  });
  await recoveryPage.getByRole('button', { name: 'Confirm permanent closure' }).click();
  await recoveryPage.getByRole('button', { name: 'Retry closure' }).waitFor();
  assert.equal(await recoveryPage.evaluate(() => sessionStorage.getItem('ff-car-creation:car-browser-alice:car-browser-close')), '{broken');
  await recoveryPage.getByRole('button', { name: 'Retry closure' }).scrollIntoViewIfNeeded();
  await recoveryPage.screenshot({ path: resolve(output, 'creation-close-uncertain-390.png') });
  assert.equal((await db.query(`SELECT "trackingClosed" FROM "CarSearchRun" WHERE id='car-browser-close'`)).rows[0].trackingClosed, true);
  await recoveryPage.unroute(`**${closureUrl}`);
  await recoveryPage.getByRole('button', { name: 'Retry closure' }).click();
  await recoveryPage.getByRole('heading', { name: 'Tracking closed for this search' }).waitFor();
  assert.equal(await recoveryPage.evaluate(() => sessionStorage.getItem('ff-car-creation:car-browser-alice:car-browser-close')), null);
  await recoveryPage.reload();
  await recoveryPage.getByRole('heading', { name: 'Tracking closed for this search' }).waitFor();
  assert.ok(await recoveryPage.getByRole('button', { name: 'Track this rental' }).isDisabled());
  assert.ok(await recoveryPage.getByRole('link', { name: 'View on provider' }).isVisible());
  assert.ok(await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await recoveryPage.getByRole('heading', { name: 'Tracking closed for this search' }).scrollIntoViewIfNeeded();
  await recoveryPage.screenshot({ path: resolve(output, 'creation-closed-390.png') });
  const knownReplay = await alice.request.post('/api/cars', { headers: { 'Idempotency-Key': savedKey }, data: savedBody });
  assert.equal(knownReplay.status(), 201, await knownReplay.text()); assert.equal((await knownReplay.json()).data.tracker.id, savedTracker.id);
  assert.equal((await alice.request.post('/api/cars', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: savedBody })).status(), 410);
  assert.equal((await alice.request.get(`/api/cars/${savedTracker.id}`)).status(), 200);
  assert.equal((await alice.request.delete(`/api/cars/${savedTracker.id}`, { headers: { 'X-Car-Revision': String(savedTracker.revision) } })).status(), 200);
  await recoveryPage.close();
  passed.push('Corrupt creation receipt: explicit keyboard closure, lost real acknowledgement, same-search retry, reload fence, preserved tracker and receipt replay, fresh-key rejection and private access boundaries');
  await alice.clearCookies(); await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /Example car/ }).count(), 0);
  await page.screenshot({ path: resolve(output, 'session-expired-390.png'), fullPage: true });
  passed.push('Expired browser session hides private results');
  await login(alice, 'car-browser-alice');
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId",request,status,"createdAt") VALUES ('car-browser-progress','car-browser-alice',$1,'running',$2)`, [search, now]);
  await page.goto('/cars/search/car-browser-progress');
  await page.getByRole('button', { name: 'Cancel search' }).waitFor();
  await db.query(`UPDATE "CarSearchRun" SET status='success', result=$1,"completedAt"=$2 WHERE id='car-browser-progress'`, [report, now]);
  await page.getByRole('button', { name: 'Track this rental' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Track this rental' }).isEnabled());
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId",request,status,"createdAt") VALUES ('car-browser-cancel','car-browser-alice',$1,'running',$2)`, [search, now]);
  await page.goto('/cars/search/car-browser-cancel');
  await page.getByRole('button', { name: 'Cancel search' }).click();
  await page.getByRole('status').filter({ hasText: 'Cancelled' }).waitFor();
  assert.equal((await db.query(`SELECT status FROM "CarSearchRun" WHERE id='car-browser-cancel'`)).rows[0].status, 'cancelled');
  await page.screenshot({ path: resolve(output, 'cancelled-390.png'), fullPage: true });
  passed.push('Progressive result polling and real cancellation persist terminal state');
  const historicalAt = new Date(Date.now() - 86_400_000).toISOString(), historicalOffer = carOfferFixture(historicalAt);
  await db.query(`INSERT INTO "CarTracker" (id,"userId",label,search,currency,"latestPriceMinor","historicalLowMinor","lastCheckedAt","lastError","createdAt","updatedAt") VALUES ('car-browser-tracker','car-browser-alice','London weekend',$1,'GBP',10000,9000,$2,'Provider could not verify this check',$3,$2)`, [search, now, historicalAt]);
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId","trackerId","trackerRevision",request,status,"createdAt","completedAt") VALUES ('car-browser-history','car-browser-alice','car-browser-tracker',0,$1,'success',$2,$2)`, [search, historicalAt]);
  await db.query(`INSERT INTO "CarSnapshot" (id,"trackerId","runId",source,offer,currency,"totalMinor",eligible,"contractHash","observedAt") VALUES ('car-browser-observation','car-browser-tracker','car-browser-history','discovercars',$1,'GBP',10000,true,$2,$3)`, [historicalOffer, carContractHash(historicalOffer.contract), historicalAt]);
  for (const state of ['waiting', 'claimed', 'retrying', 'accepted', 'stopped']) {
    const pending = !['accepted', 'stopped'].includes(state);
    await db.query(`INSERT INTO "TravelAlertDelivery" (id,"carTrackerId","eventKey",message,pending,"deliveredIds","lastError","claimExpiresAt") VALUES ($1,'car-browser-tracker',$2,$3,$4,$5,$6,$7)`, [
      `car-browser-delivery-${state}`, `private-event-${state}`, { title: 'private-message-sentinel' }, pending,
      ['accepted', 'retrying'].includes(state) ? ['private-channel-sentinel'] : [],
      ['retrying', 'stopped'].includes(state) ? 'private-error-sentinel' : null,
      state === 'claimed' ? new Date(Date.now() + 120_000).toISOString() : null,
    ]);
  }
  const deliveryResponse = await alice.request.get('/api/cars/car-browser-tracker');
  assert.equal(deliveryResponse.status(), 200, await deliveryResponse.text());
  const deliveryBody = await deliveryResponse.text();
  assert.doesNotMatch(deliveryBody, /private-message-sentinel|private-channel-sentinel|private-error-sentinel|private-event-|claimExpiresAt|claimToken|deliveredIds/);
  assert.deepEqual(new Set(JSON.parse(deliveryBody).data.deliveries.map((entry: { status: string }) => entry.status)), new Set(['waiting', 'claimed', 'retrying', 'accepted', 'stopped']));
  await page.goto('/cars/car-browser-tracker');
  const deliveryRegion = page.getByRole('region', { name: 'Notification delivery', exact: true });
  await deliveryRegion.getByText('Accepted by channels', { exact: true }).waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await deliveryRegion.screenshot({ path: resolve(output, `notification-delivery-${width}.png`) });
  }
  passed.push('Notification history distinguishes five stored outcomes and HTTP responses omit messages, channel identities, claim credentials and raw errors');
  await page.getByRole('heading', { name: 'London weekend' }).waitFor();
  await page.getByText('Auto Europe search location: London Heathrow Airport rental search area', { exact: true }).waitFor();
  assert.equal(await page.locator('h1').count(), 1);
  assert.match(await page.locator('meta[name="robots"]').getAttribute('content') ?? '', /noindex/);
  assert.match(await page.getByRole('region', { name: 'London weekend', exact: true }).getByRole('alert').innerText(), /needs attention/);
  assert.equal(await page.getByText('Latest evidence for this total', { exact: true }).locator('..').locator('time').getAttribute('datetime'), historicalAt);
  assert.equal(await page.getByText('Last check attempted', { exact: true }).locator('..').locator('time').getAttribute('datetime'), now);
  const evidence = page.getByText('Evidence for the retained price', { exact: true });
  await evidence.focus(); await page.keyboard.press('Enter');
  assert.ok(await evidence.locator('..').getByText('Charges, extras and rental conditions', { exact: true }).isVisible());
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(output, `tracker-history-${width}.png`), fullPage: true });
  }
  passed.push('Tracker history preserves evidence timestamps through failed checks and supports keyboard disclosure');
  let refreshKey = '', refreshRun = '';
  await page.route('**/api/cars/car-browser-tracker/scrape', async route => {
    refreshKey = route.request().headers()['idempotency-key']!;
    const accepted = await route.fetch(); assert.equal(accepted.status(), 202, await accepted.text());
    refreshRun = (await accepted.json()).data.id;
    await route.abort();
  });
  await page.getByRole('button', { name: 'Check saved rental prices', exact: true }).click();
  await page.getByRole('button', { name: 'Recover price check', exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Pause tracking', exact: true }).isEnabled());
  await page.getByRole('region', { name: 'Check prices now', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'refresh-lost-ack-390.png') });
  assert.equal((await alice.request.delete(`/api/cars/search/${refreshRun}`)).status(), 200);
  await page.unroute('**/api/cars/car-browser-tracker/scrape');
  await page.reload();
  await page.getByRole('button', { name: 'Recover price check', exact: true }).click();
  await page.getByText('Check request confirmed. Review recent checks for its outcome.', { exact: true }).waitFor();
  assert.equal(Number((await db.query(`SELECT count(*) FROM "CarRefreshRequest" WHERE "trackerId"='car-browser-tracker'`)).rows[0].count), 1);
  assert.equal((await db.query(`SELECT status FROM "CarSearchRun" WHERE id=$1`, [refreshRun])).rows[0].status, 'cancelled');
  const replay = await alice.request.post('/api/cars/car-browser-tracker/scrape', { headers: { 'Idempotency-Key': refreshKey, 'X-Car-Revision': '0' } });
  assert.equal((await replay.json()).data.id, refreshRun);
  await page.getByRole('region', { name: 'Check prices now', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'refresh-recovered-390.png') });
  passed.push('Durable manual refresh: accepted response lost, original run cancelled, browser remount and same-key replay recover without another check');
  for (const locale of ['es', 'fr', 'de', 'pt']) {
    const copy = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/cars.json`), 'utf8')).Cars;
    const localized = await context(privateUrl, locale); await login(localized, 'car-browser-alice');
    const localizedPage = await localized.newPage(); await localizedPage.setViewportSize({ width: 390, height: 1000 });
    await localizedPage.goto('/cars/car-browser-tracker');
    await localizedPage.getByRole('heading', { name: copy.trackerTitle, level: 1 }).waitFor();
    await localizedPage.getByRole('heading', { name: copy.verifiedHistory }).waitFor();
    assert.ok(await localizedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Tracker ${locale} does not overflow`);
    await localizedPage.screenshot({ path: resolve(output, `tracker-history-${locale}-390.png`), fullPage: true });
  }
  assert.equal((await bob.request.get('/cars/car-browser-tracker')).status(), 404);
  assert.equal((await bob.request.get('/api/cars/car-browser-tracker')).status(), 404);
  assert.equal((await publicCtx.request.get('/cars/car-browser-tracker')).status(), 404);
  await anonymousPage.goto('/cars/car-browser-tracker'); assert.equal(new URL(anonymousPage.url()).pathname, '/login');
  await db.query(`UPDATE "User" SET "isAdmin"=true WHERE id='car-browser-bob'`);
  assert.equal((await bob.request.get('/cars/car-browser-tracker')).status(), 200);
  passed.push('Five locale tracker layouts and owner, administrator, foreign and anonymous page access');
  await page.route('**/api/cars/car-browser-tracker', route => route.abort());
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('alert').filter({ hasText: 'History updates interrupted' }).waitFor();
  assert.ok(await page.getByRole('heading', { name: 'London weekend' }).isVisible());
  await page.screenshot({ path: resolve(output, 'tracker-interrupted-390.png'), fullPage: true });
  await page.unroute('**/api/cars/car-browser-tracker');
  await page.getByRole('button', { name: 'Retry status updates' }).click();
  await page.getByRole('button', { name: 'Refresh status' }).waitFor();
  await alice.clearCookies(); await page.getByRole('button', { name: 'Check saved rental prices', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'London weekend' }).count(), 0);
  await page.screenshot({ path: resolve(output, 'tracker-session-expired-390.png'), fullPage: true });
  await login(alice, 'car-browser-alice');
  await page.getByRole('button', { name: 'Retry status updates' }).click();
  await page.getByRole('heading', { name: 'London weekend' }).waitFor();
  passed.push('Tracker history survives transport failure and manual refresh hides all private content after session expiry');
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId","trackerId","trackerRevision",request,status,"createdAt") VALUES ('car-browser-tracker-queued','car-browser-alice','car-browser-tracker',0,$1,'queued',$2)`, [search, now]);
  await page.reload();
  await page.getByRole('region', { name: 'Recent checks' }).getByText('Waiting', { exact: true }).waitFor();
  await db.query(`UPDATE "CarSearchRun" SET status='failed',error='Provider check unavailable',"completedAt"=now() WHERE id='car-browser-tracker-queued'`);
  await page.getByRole('region', { name: 'Recent checks' }).getByText('Check failed', { exact: true }).waitFor();
  assert.equal(await page.getByText('Latest evidence for this total', { exact: true }).locator('..').locator('time').getAttribute('datetime'), historicalAt);
  passed.push('Queued tracker work polls to its terminal result without freshening historical prices');
  await db.query(`INSERT INTO "CarSearchRun" (id,"userId","trackerId","trackerRevision",request,status,"createdAt") VALUES ('car-browser-active-edit','car-browser-alice','car-browser-tracker',0,$1,'running',now())`, [search]);
  await page.reload();
  let loseEditAcknowledgement = true;
  await page.route('**/api/cars/car-browser-tracker', async route => {
    if (route.request().method() !== 'PATCH' || !loseEditAcknowledgement) return route.continue();
    loseEditAcknowledgement = false;
    assert.equal(route.request().headers()['x-car-revision'], '0');
    const result = await route.fetch(); assert.equal(result.status(), 200, await result.text());
    await route.abort();
  });
  await page.getByRole('button', { name: 'Pause tracking' }).click();
  await page.getByRole('button', { name: 'Recover this action' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Recover this action' && !button.disabled));
  await page.screenshot({ path: resolve(output, 'tracker-edit-uncertain-390.png'), fullPage: true });
  assert.equal((await db.query(`SELECT status FROM "CarSearchRun" WHERE id='car-browser-active-edit'`)).rows[0].status, 'cancelled');
  await page.getByRole('button', { name: 'Recover this action' }).click();
  await page.getByText('The requested settings are currently saved.', { exact: true }).waitFor();
  assert.deepEqual((await db.query(`SELECT revision,active FROM "CarTracker" WHERE id='car-browser-tracker'`)).rows[0], { revision: 1, active: false });
  await page.unroute('**/api/cars/car-browser-tracker');
  passed.push('Lost pause acknowledgement recovers one revision and cancels active tracker work');
  await page.getByRole('button', { name: 'Load current settings' }).click();
  await page.getByLabel('Alert at or below total (GBP)', { exact: true }).fill('85.75');
  await page.getByLabel('Check every (hours)', { exact: true }).fill('6');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved and confirmed.', { exact: true }).waitFor();
  assert.deepEqual((await db.query(`SELECT revision,"targetMinor","scrapeInterval" FROM "CarTracker" WHERE id='car-browser-tracker'`)).rows[0], { revision: 2, targetMinor: '8575', scrapeInterval: 6 });
  await page.getByRole('button', { name: 'Delete tracker', exact: true }).click();
  const externalEdit = await alice.request.patch('/api/cars/car-browser-tracker', { headers: { 'X-Car-Revision': '2' }, data: { label: 'Updated in another tab' } });
  assert.equal(externalEdit.status(), 200, await externalEdit.text());
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('heading', { name: 'Updated in another tab' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Yes, delete tracker' }).isDisabled());
  await page.screenshot({ path: resolve(output, 'tracker-delete-conflict-390.png'), fullPage: true });
  await page.getByRole('button', { name: 'Keep tracker' }).click();
  passed.push('Settings persist exact money and stale delete confirmation cannot delete a newer revision');
  await page.evaluate(() => sessionStorage.setItem('ff-car-management:car-browser-alice:car-browser-tracker', '{broken'));
  await page.reload();
  assert.ok(await page.getByRole('button', { name: 'Resume tracking' }).isDisabled());
  await page.getByRole('button', { name: 'Pause and recover controls' }).click();
  await page.getByText('Settings saved and confirmed.', { exact: true }).waitFor();
  const staleDelete = await alice.request.delete('/api/cars/car-browser-tracker', { headers: { 'X-Car-Revision': '3' } });
  assert.equal(staleDelete.status(), 412, await staleDelete.text());
  assert.deepEqual((await db.query(`SELECT revision,active FROM "CarTracker" WHERE id='car-browser-tracker'`)).rows[0], { revision: 4, active: false });
  passed.push('Explicit corrupt-record recovery pauses and fences an older pending deletion');
  const administratorDetail = await bob.request.get('/api/cars/car-browser-tracker');
  assert.equal(administratorDetail.status(), 200, await administratorDetail.text());
  assert.equal((await administratorDetail.json()).data.canReassign, true);
  const administratorPage = await bob.newPage(); await administratorPage.goto('/cars/car-browser-tracker');
  await administratorPage.getByRole('heading', { name: 'Updated in another tab' }).waitFor();
  await administratorPage.screenshot({ path: resolve(output, 'tracker-administrator.png'), fullPage: true });
  await administratorPage.getByRole('combobox', { name: 'New owner', exact: true }).selectOption('car-browser-bob');
  await administratorPage.getByRole('button', { name: 'Reassign tracker', exact: true }).click();
  await administratorPage.getByText('Settings saved and confirmed.', { exact: true }).waitFor();
  assert.equal((await db.query(`SELECT "userId" FROM "CarTracker" WHERE id='car-browser-tracker'`)).rows[0].userId, 'car-browser-bob');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Updated in another tab' }).count(), 0);
  let loseDeleteAcknowledgement = true;
  await administratorPage.route('**/api/cars/car-browser-tracker', async route => {
    if (route.request().method() !== 'DELETE' || !loseDeleteAcknowledgement) return route.continue();
    loseDeleteAcknowledgement = false;
    const result = await route.fetch(); assert.equal(result.status(), 200, await result.text());
    await route.abort();
  });
  await administratorPage.getByRole('button', { name: 'Delete tracker', exact: true }).click();
  await administratorPage.getByRole('button', { name: 'Yes, delete tracker' }).click();
  await administratorPage.getByRole('button', { name: 'Recover this action' }).waitFor();
  await administratorPage.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Recover this action' && !button.disabled));
  await administratorPage.getByRole('button', { name: 'Retry status updates' }).click();
  await administratorPage.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
  assert.equal((await db.query(`SELECT count(*) FROM "CarTracker" WHERE id='car-browser-tracker'`)).rows[0].count, '0');
  assert.equal(await administratorPage.getByText('Rental tracker deleted. No booking was cancelled.', { exact: true }).count(), 0);
  passed.push('Administrator reassignment revokes old-owner access and lost deletion acknowledgement resolves without false attribution');
  await administratorPage.goto('/cars');
  await administratorPage.getByText('No saved rental trackers. Rentals you choose to track will appear here.', { exact: true }).waitFor();
  assert.match(await administratorPage.locator('meta[name="robots"]').getAttribute('content') ?? '', /noindex/);
  await administratorPage.screenshot({ path: resolve(output, 'tracker-list-empty-1280.png') });
  for (let index = 0; index < 27; index++) {
    await db.query(`INSERT INTO "CarTracker" (id,"userId",label,search,currency,"latestPriceMinor","createdAt","updatedAt") VALUES ($1,'car-browser-alice',$2,$3,'GBP',$4,now(),now())`, [`car-browser-list-${String(index).padStart(2, '0')}`, `Saved rental ${String(index).padStart(2, '0')}`, search, index === 0 ? null : 10000 + index]);
  }
  await db.query(`INSERT INTO "CarTracker" (id,"userId",label,search,currency,"createdAt","updatedAt") VALUES ('car-browser-list-bob','car-browser-bob','Private Bob rental',$1,'GBP',now(),now())`, [search]);
  await page.goto('/cars');
  await page.getByRole('heading', { name: 'Rental car tracking', exact: true }).waitFor();
  await page.getByRole('link', { name: /Saved rental 26/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Saved rental/ }).count(), 25);
  assert.equal(await page.getByRole('link', { name: /Private Bob rental/ }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Cars', exact: true }).getAttribute('aria-current'), 'page');
  await page.getByRole('button', { name: 'Load more rentals' }).click();
  await page.getByRole('link', { name: /Saved rental 00/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Saved rental/ }).count(), 27);
  assert.equal(await page.getByRole('button', { name: 'Load more rentals' }).count(), 0);
  assert.match(await page.getByRole('link', { name: /Saved rental 00/ }).innerText(), /Unknown/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Rental dashboard fits ${width}`);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(output, `tracker-list-${width}.png`) });
  }
  await page.getByRole('link', { name: /Saved rental 26/ }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Saved rental 26', exact: true }).waitFor();
  passed.push('Owned rental dashboard loads all pages with honest missing prices, accessible navigation and responsive layout');
  await page.goto('/cars'); await page.getByRole('link', { name: /Saved rental 26/ }).waitFor();
  await page.route('**/api/cars?*', route => route.abort());
  await page.getByRole('button', { name: 'Refresh rental list' }).click();
  await page.getByRole('alert').filter({ hasText: 'could not be updated' }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Saved rental/ }).count(), 25);
  await page.screenshot({ path: resolve(output, 'tracker-list-interrupted-390.png') });
  await page.unroute('**/api/cars?*');
  await page.getByRole('button', { name: 'Retry rental list' }).click();
  await page.getByRole('button', { name: 'Load more rentals' }).waitFor();
  await alice.clearCookies(); await page.getByRole('button', { name: 'Load more rentals' }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Saved rental/ }).count(), 0);
  await page.screenshot({ path: resolve(output, 'tracker-list-session-expired-390.png') });
  await login(alice, 'car-browser-alice');
  passed.push('Dashboard retains its last view on transport failure and hides every row after session expiry');
  for (const locale of ['es', 'fr', 'de', 'pt']) {
    const copy = JSON.parse(await readFile(resolve(`apps/web/messages/${locale}/cars.json`), 'utf8')).Cars;
    const localized = await context(privateUrl, locale); await login(localized, 'car-browser-alice');
    const localizedPage = await localized.newPage(); await localizedPage.setViewportSize({ width: 390, height: 1000 }); await localizedPage.goto('/cars');
    await localizedPage.getByRole('heading', { name: copy.carsTitle, exact: true }).waitFor();
    await localizedPage.getByRole('link', { name: /Saved rental 26/ }).waitFor();
    assert.ok(await localizedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await localizedPage.screenshot({ path: resolve(output, `tracker-list-${locale}-390.png`) });
  }
  await administratorPage.goto('/account');
  const ownRentals = administratorPage.getByRole('region', { name: 'Your saved rentals' });
  await ownRentals.getByRole('link', { name: /Private Bob rental/ }).waitFor();
  assert.equal(await ownRentals.getByRole('link', { name: /Saved rental/ }).count(), 0);
  await administratorPage.goto('/admin/queries');
  await administratorPage.getByRole('region', { name: 'All saved rentals' }).getByRole('link', { name: /Saved rental 26/ }).waitFor();
  assert.equal((await fetch(`${publicUrl}/cars`)).status, 404);
  const anonymousList = await fetch(`${privateUrl}/cars`, { redirect: 'manual' });
  assert.equal(anonymousList.status, 307); assert.match(anonymousList.headers.get('location') ?? '', /login/);
  passed.push('Five locale dashboards and private account/admin entrypoints enforce scope; public and anonymous access stay closed');
  await travelRecoveryBrowserScenarios(db, bob, alice, publicCtx, privateUrl, output);
  passed.push('Administrator recovery in five locales and both themes: explicit checks, real lost acknowledgement, status reconciliation, retained history and revoked access');
  assert.deepEqual(errors, []); await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed, errors }, null, 2));
  for (const name of passed) console.log(`PASS ${name}`);
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ passed, errors, error: String(error) }, null, 2)); throw error;
} finally {
  for (const ctx of contexts) await ctx.close(); await browser?.close();
  for (const { child, log } of servers) {
    child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); log.end();
  }
  if (connected && seeded) {
    await db.query(`DELETE FROM "User" WHERE id IN ('car-browser-alice','car-browser-bob')`);
    await db.query(`DELETE FROM "ExtractionConfig" WHERE id = 'singleton'`);
  }
  await db.end();
}
