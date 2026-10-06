import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Use a disposable local instance/database');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD, 'Provide an initialized disposable administrator');
const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: process.env.TEST_ACCESS_NAME }) });
assert.equal(login.status, 200, await login.text());
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', viewport: { width: 1280, height: 1000 } });
await addBrowserSession(context, origin, token);
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text());
});
const queryIds = Array.from({ length: 3 }, () => randomUUID());
const groupId = randomUUID();
const oldTime = new Date(Date.now() - 2 * 3600_000);
const newTime = new Date(Date.now() - 3600_000);

async function observation(queryId, date, price, currency, when, flightNumber, extra = {}) {
  const id = randomUUID();
  const flightId = `Delta-${flightNumber ?? '0800'}-JFK-LAX-${date}`;
  await pool.query('INSERT INTO "PriceSnapshot" (id, "queryId", "travelDate", price, currency, airline, "flightId", "flightNumber", "departureTime", "arrivalTime", "scrapedAt", "bookingUrl", status, "vpnCountry") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id, queryId, date, price, currency, 'Delta', flightId, flightNumber, '08:00', '11:00', when, `https://booking.example/fare-${price}`, extra.status ?? 'available', extra.vpnCountry ?? null]);
  return id;
}

try {
  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  assert.ok(owner);
  for (let index = 0; index < queryIds.length; index++) {
    const date = `2027-06-${15 + index}`;
    await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","groupId","userId","updatedAt","tripType") VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,now(),$11)',
      [queryIds[index], 'Latest observed fare browser acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', date, '2027-06-20', groupId, owner.id, 'one_way']);
  }
  await observation(queryIds[0], '2027-06-15', 90, 'USD', oldTime, null);
  const newestPrimary = await observation(queryIds[0], '2027-06-15', 240, 'USD', newTime, 'DL100');
  await observation(queryIds[0], '2027-06-15', 1, 'EUR', newTime, 'DL100', { vpnCountry: 'DE' });
  await observation(queryIds[1], '2027-06-16', 110, 'USD', oldTime, 'DL100');
  await observation(queryIds[1], '2027-06-16', 210, 'USD', newTime, 'DL100');
  await observation(queryIds[2], '2027-06-17', 1, 'EUR', oldTime, 'DL100');
  await pool.query('UPDATE "Query" SET "dateTo"=$1 WHERE id=$2', ['2027-06-16', queryIds[0]]);
  await observation(queryIds[0], '2027-06-16', 95, 'USD', oldTime, 'DL200');
  await observation(queryIds[0], '2027-06-16', 300, 'USD', newTime, 'DL200');

  await page.goto(`${origin}/q/${queryIds[0]}`);
  const fares = page.getByRole('region', { name: 'Latest observed price', exact: true });
  assert.equal(await fares.count(), 2, 'Only comparable USD fares should have booking cards');
  const first = fares.nth(0);
  assert.match(await first.innerText(), /240/);
  assert.equal(await first.getByRole('link').getAttribute('href'), 'https://booking.example/fare-240');
  assert.match(await page.getByRole('complementary', { name: 'Historical low' }).nth(0).innerText(), /90/);
  const calendar = page.getByRole('region', { name: 'Cheapest by Date', exact: true });
  assert.deepEqual(await calendar.getByRole('link').evaluateAll(links => links.map(link => link.href)),
    ['https://booking.example/fare-240', 'https://booking.example/fare-300']);
  await page.getByLabel('Sort', { exact: true }).selectOption('price');
  assert.match(await fares.nth(0).innerText(), /210/);
  assert.match(await fares.nth(1).innerText(), /240/);
  await page.screenshot({ path: '/tmp/flight-latest-fares-desktop.png', fullPage: true });

  const edited = await fetch(`${origin}/api/queries/${queryIds[0]}`, { method: 'PATCH', headers, body: JSON.stringify({ maxPrice: 100 }) });
  assert.equal(edited.status, 200, await edited.text());
  await page.reload();
  assert.equal(await fares.count(), 0, 'A newer over-budget observation must not restore old qualifying prices in any sibling');
  assert.ok(await page.getByText('No latest observation matches these filters.', { exact: true }).count() > 0);
  assert.equal(await page.getByRole('complementary', { name: 'Historical low' }).getByRole('link').count(), 0);
  assert.equal(await page.getByRole('region', { name: 'Cheapest by Date', exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile page must fit the viewport');
  await page.screenshot({ path: '/tmp/flight-latest-fares-mobile.png', fullPage: true });

  const cleared = await fetch(`${origin}/api/queries/${queryIds[0]}`, { method: 'PATCH', headers, body: JSON.stringify({ maxPrice: null }) });
  assert.equal(cleared.status, 200, await cleared.text());
  await pool.query('UPDATE "PriceSnapshot" SET status=$1 WHERE id=$2', ['sold_out', newestPrimary]);
  await pool.query('UPDATE "PriceSnapshot" SET status=$1 WHERE "queryId"=$2 AND price=$3', ['sold_out', queryIds[0], 300]);
  await page.reload();
  assert.equal(await fares.count(), 1, 'The sold-out primary must have history without a booking card');
  assert.match(await fares.nth(0).innerText(), /210/);
  assert.deepEqual(errors, [], 'Browser runtime/hydration errors');
  console.log('Latest-fare browser/Postgres/API acceptance passed: legacy aliases, historical low, booking target, common currency, sibling sorting, budget cascade, unavailable observations, mobile layout and hydration.');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=ANY($1::text[])', [queryIds]);
  await context.close();
  await browser.close();
  await pool.end();
}
