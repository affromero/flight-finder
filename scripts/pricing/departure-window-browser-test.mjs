import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Use a disposable local instance/database');
assert.ok(database.port && database.pathname === '/flight_forks', 'Use the explicitly ported disposable flight_forks database');
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
page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
const queryIds = [randomUUID(), randomUUID()];
const groupId = randomUUID();
const clocks = ['09:00', '12:00 PM', '18:00', '18:01', '10:00 PM', null];
const observedAt = new Date().toISOString();
const cliEntry = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));

async function cliJson(view) {
  const args = [cliEntry, '--json', ...(view ? ['--view', view] : [])];
  const { stdout } = await promisify(execFile)(process.execPath, args, { env: process.env, timeout: 15000 });
  return JSON.parse(stdout);
}

async function patch(criteria) {
  return fetch(`${origin}/api/queries/${queryIds[0]}`, { method: 'PATCH', headers, body: JSON.stringify(criteria) });
}

async function prices(id) {
  const response = await fetch(`${origin}/api/queries/${id}/prices`, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data.snapshots.map(snapshot => snapshot.departureTime);
}

async function waitForTwoBlockedEdits() {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND query LIKE $2', ['Lock', '%FOR UPDATE%']);
    if (result.rows[0].count >= 2) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Concurrent edits did not both reach the database row lock');
}

try {
  const config = (await pool.query('SELECT enabled,"setupComplete" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false, 'Disable scheduling in the disposable database before adding active test trackers');
  assert.equal(config?.setupComplete, true, 'Complete setup through the API before testing the search UI');
  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  assert.ok(owner);
  for (let index = 0; index < queryIds.length; index++) {
    const date = `2027-06-${15 + index}`;
    await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","groupId","userId","updatedAt","tripType","timePreference") VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,now(),$11,$12)',
      [queryIds[index], 'Departure window browser acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', date, '2027-06-20', groupId, owner.id, 'one_way', 'morning']);
    for (let clockIndex = 0; clockIndex < clocks.length; clockIndex++) {
      const flightNumber = `DL${100 + clockIndex}`;
      await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,stops,duration,"flightId","flightNumber","departureTime","scrapedAt","bookingUrl",status) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$13,$11,$12)',
        [randomUUID(), queryIds[index], date, clockIndex === 0 ? 500 : 100 + clockIndex, 'USD', 'Delta', '2h', `Delta-${flightNumber}-JFK-LAX-${date}`, flightNumber, clocks[clockIndex], `https://booking.example/${flightNumber}`, 'available', observedAt]);
    }
  }
  assert.deepEqual((await prices(queryIds[0])).sort(), [...clocks].sort(), 'Soft preference retains every observation');
  assert.equal((await cliJson(queryIds[0])).snapshotCount, 6, 'Packaged CLI retains soft-preference history');
  await page.goto(`${origin}/q/${queryIds[0]}`);
  await page.getByRole('button', { name: /^Filters/ }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Only include flights in this window' });
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.check();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => {
    const fares = [...document.querySelectorAll('[aria-label="Latest observed price"]')];
    return fares.length > 0 && fares.every(element => element.textContent.includes('500'));
  });
  for (const id of queryIds) assert.deepEqual(await prices(id), ['09:00']);
  const strictCli = await cliJson(queryIds[0]);
  assert.equal(strictCli.snapshotCount, 1);
  assert.equal(strictCli.bestPrice.price, 500);
  const strictList = (await cliJson()).filter(query => queryIds.includes(query.id));
  assert.equal(strictList.length, 2);
  assert.ok(strictList.every(query => query.snapshotCount === 1 && query.minPrice === 500));
  const booking = page.getByRole('region', { name: 'Latest observed price', exact: true }).first();
  assert.equal(await booking.getByRole('link').getAttribute('href'), 'https://booking.example/DL100');
  await page.waitForFunction(() => {
    const charts = [...document.querySelectorAll('.js-plotly-plot')];
    return charts.length === 2 && charts.every(chart => chart.data?.length && chart.data.flatMap(trace => trace.y ?? []).every(price => price === 500));
  });
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.screenshot({ path: '/tmp/flight-departure-strict-desktop.png', fullPage: true });
  for (const [window, expected] of [['afternoon', ['12:00 PM', '18:00']], ['evening', ['18:01', '10:00 PM']], ['redeye', ['10:00 PM']]]) {
    const response = await patch({ timePreference: window, strictDepartureTime: true });
    assert.equal(response.status, 200, await response.text());
    for (const id of queryIds) assert.deepEqual((await prices(id)).sort(), expected.sort());
  }
  const disabled = await patch({ timePreference: 'any', strictDepartureTime: false });
  assert.equal(disabled.status, 200, await disabled.text());
  for (const id of queryIds) assert.equal((await prices(id)).length, clocks.length);
  assert.equal((await cliJson(queryIds[0])).snapshotCount, 6, 'Disabling the window restores packaged CLI history');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "PriceSnapshot" WHERE "queryId"=ANY($1::text[])', [queryIds])).rows[0].count, 12, 'Edits preserve all stored history');
  assert.ok((await pool.query('SELECT count(*)::int AS count FROM "QueryEditEvent" WHERE "queryId"=ANY($1::text[])', [queryIds])).rows[0].count >= 10, 'Each changed sibling records edit history');

  const reset = await patch({ timePreference: 'morning', strictDepartureTime: false });
  assert.equal(reset.status, 200, await reset.text());
  const blocker = await pool.connect();
  let requests;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "Query" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [queryIds]);
    requests = [patch({ strictDepartureTime: true }), patch({ timePreference: 'any' })];
    await waitForTwoBlockedEdits();
    await blocker.query('COMMIT');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const statuses = await Promise.all(requests.map(async request => (await request).status));
  assert.deepEqual(statuses.sort(), [200, 409], 'Conflicting concurrent edits must not both commit');
  const criteria = (await pool.query('SELECT "timePreference","strictDepartureTime" FROM "Query" WHERE id=ANY($1::text[])', [queryIds])).rows;
  assert.ok(criteria.every(row => !row.strictDepartureTime || row.timePreference !== 'any'));
  const clear = await patch({ timePreference: 'any', strictDepartureTime: false });
  assert.equal(clear.status, 200, await clear.text());
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const charts = [...document.querySelectorAll('.js-plotly-plot')];
    return charts.length === 2 && charts.every(chart => chart.data?.flatMap(trace => trace.y ?? []).length === 6);
  });
  await page.getByRole('button', { name: /^Filters/ }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Only include flights in this window' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile page must fit the viewport');
  await page.screenshot({ path: '/tmp/flight-departure-strict-mobile.png', fullPage: true });

  await page.goto(origin);
  if (await page.getByRole('button', { name: 'Enter flight details manually', exact: true }).count()) {
    await page.getByRole('button', { name: 'Enter flight details manually', exact: true }).click();
  }
  for (const [label, code] of [['Origin', 'JFK'], ['Destination', 'LAX']]) {
    await page.getByRole('combobox', { name: label, exact: true }).fill(code);
    await page.getByRole('option', { name: new RegExp(`^${code}`) }).first().click();
  }
  await page.locator('#me-date-from').fill('2027-06-15');
  await page.locator('#me-date-to').fill('2027-06-20');
  await page.getByRole('button', { name: 'Advanced options', exact: true }).click();
  await page.getByRole('combobox', { name: 'Outbound departure window', exact: true }).selectOption('morning');
  await page.getByRole('button', { name: 'Show available flights', exact: true }).click();
  const confirmationWindow = page.getByRole('combobox', { name: 'Outbound departure window', exact: true });
  await confirmationWindow.selectOption('afternoon');
  await page.getByRole('checkbox', { name: 'Only include flights in this window' }).check();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Outbound departure window' }).inputValue(), 'afternoon');
  assert.equal(await page.getByRole('checkbox', { name: 'Only include flights in this window' }).isChecked(), true);
  await page.getByRole('button', { name: 'Show available flights', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Outbound departure window' }).inputValue(), 'afternoon');
  assert.equal(await page.getByRole('checkbox', { name: 'Only include flights in this window' }).isChecked(), true);
  assert.deepEqual(errors, [], 'Browser runtime and hydration errors');
  console.log('Departure-window browser/PostgreSQL/API acceptance passed: opt-in, clock boundaries, unknown exclusion, booking targets, grouped edits, retained history, concurrent conflict, confirmation/edit/resubmission, mobile layout and hydration.');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=ANY($1::text[])', [queryIds]);
  await context.close();
  await browser.close();
  await pool.end();
}
