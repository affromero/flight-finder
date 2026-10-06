import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Use disposable local services');
assert.ok(database.port && database.pathname === '/flight_forks', 'Use explicitly ported flight_forks');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD);
const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
assert.equal((await fetch(`${origin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: process.env.TEST_ACCESS_NAME }) })).status, 200);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ids = [randomUUID(), randomUUID()];
const groupId = randomUUID(), capability = randomUUID();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
context.setDefaultTimeout(15000);
await addBrowserSession(context, origin, token);
const page = await context.newPage(), errors = [];
let memberId, originalMultiUser;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
const route = page.getByRole('region', { name: /Jun 15, 2027$/ });
const panel = route.getByRole('region', { name: 'Price alert rules', exact: true });
async function openPanel() {
  await route.getByRole('button', { name: 'Price alerts', exact: true }).click();
  await panel.getByRole('button', { name: 'Add rule', exact: true }).waitFor();
}
async function savePanel() {
  const response = page.waitForResponse(response => response.url().endsWith(`/api/queries/${ids[0]}/alerts`) && response.request().method() === 'PUT');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  const result = await response; assert.equal(result.status(), 200, await result.text());
  await panel.waitFor({ state: 'hidden' });
}
async function request(id, method = 'GET', body, requestHeaders = headers) {
  const response = await fetch(`${origin}/api/queries/${id}/alerts`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.match(response.headers.get('Cache-Control') ?? '', /private, no-store/);
  return { status: response.status, body: await response.json() };
}
try {
  const config = (await pool.query('SELECT enabled,"setupComplete","multiUserMode" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false); assert.equal(config?.setupComplete, true);
  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  for (let index = 0; index < ids.length; index++) {
    const travelDate = `2027-06-${15 + index}`;
    await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","userId",currency,"updatedAt","firstViewedAt",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,now(),now(),false)',
      [ids[index], 'Price rules acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', travelDate, '2027-06-20', owner.id, index === 0 ? 'USD' : null]);
    await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime","scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())',
      [randomUUID(), ids[index], travelDate, 200, 'USD', 'Fixture Air', `FixtureAir-FA100-JFK-LAX-${travelDate}`, 'FA100', '08:00']);
  }
  await pool.query('UPDATE "Query" SET "groupId"=$1,"deleteToken"=$2 WHERE id=ANY($3::text[])', [groupId, capability, ids]);
  const before = (await pool.query('SELECT "updatedAt" FROM "Query" WHERE id=$1', [ids[0]])).rows[0].updatedAt;
  const initial = await request(ids[0]); assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.data.settings.rules, []); assert.equal(initial.body.data.settings.revision, 0);
  const flight = initial.body.data.settings.flights[0]; assert.equal(flight.currency, 'USD');
  const created = await request(ids[0], 'PUT', { revision: 0, rules: [{ flightId: flight.id, currency: 'USD', targetPrice: 100 }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const settings = created.body.data.settings; assert.equal(settings.revision, 1);
  assert.equal((await request(ids[0], 'PUT', { revision: 1, rules: settings.rules })).body.data.settings.revision, 1);
  assert.equal((await request(ids[0], 'PUT', { revision: 0, rules: settings.rules })).status, 409);
  assert.equal((await request(ids[1], 'PUT', { revision: 0, rules: settings.rules })).status, 400, 'Foreign rule IDs are refused');
  assert.equal((await request(ids[0], 'PUT', { revision: 1, rules: [{ ...settings.rules[0], targetPrice: '100' }] })).status, 400);
  const concurrent = await Promise.all([110, 120].map(targetPrice => request(ids[0], 'PUT', { revision: 1, rules: [{ ...settings.rules[0], targetPrice }] })));
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const current = concurrent.find(response => response.status === 200).body.data.settings;
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime",status,"scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())',
    [randomUUID(), ids[0], '2027-06-15', 200, 'USD', 'Fixture Air', flight.id, 'FA100', '08:00', 'sold_out']);
  const paused = await request(ids[0], 'PUT', { revision: current.revision, rules: current.rules.map(rule => ({ ...rule, enabled: false })) });
  assert.equal(paused.status, 200, 'An unavailable flight must not prevent pausing its rule');
  assert.equal(paused.body.data.settings.rules[0].enabled, false);
  const secondaryFlight = (await request(ids[1])).body.data.settings.flights[0];
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime","scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())',
    [randomUUID(), ids[1], '2027-06-16', 180, 'EUR', 'Fixture Air', secondaryFlight.id, 'FA100', '08:00']);
  const mixed = (await request(ids[1])).body.data.settings;
  assert.equal(mixed.currency, 'EUR');
  assert.deepEqual(mixed.flights.map(flight => flight.currency).sort(), ['EUR', 'USD']);
  const explicit = await request(ids[1], 'PUT', { revision: 0, rules: [{ flightId: secondaryFlight.id, currency: 'USD', targetPrice: 100 }] });
  assert.equal(explicit.status, 200, 'A valid explicit-currency flight rule must not depend on the auto comparison anchor');
  assert.equal(explicit.body.data.settings.rules[0].currency, 'USD');
  originalMultiUser = config.multiUserMode;
  await pool.query('UPDATE "ExtractionConfig" SET "multiUserMode"=true WHERE id=$1', ['singleton']);
  const createdMember = await fetch(`${origin}/api/admin/users`, { method: 'POST', headers, body: JSON.stringify({ username: `rule-${randomUUID().slice(0, 8)}` }) });
  assert.equal(createdMember.status, 201);
  const member = (await createdMember.json()).data.user; memberId = member.id;
  const memberToken = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
  const memberHeaders = { ...headers, Cookie: `ft-session=${memberToken}` };
  assert.equal((await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ username: member.username }) })).status, 200);
  assert.ok([401, 403].includes((await request(ids[0], 'GET', undefined, memberHeaders)).status));
  assert.ok([401, 403].includes((await request(ids[0], 'PUT', { revision: paused.body.data.settings.revision, rules: [] }, memberHeaders)).status));
  const capable = await request(ids[0], 'GET', undefined, { ...memberHeaders, 'x-delete-token': capability });
  assert.equal(capable.status, 200);
  assert.equal((await request(ids[0], 'PUT', { revision: capable.body.data.settings.revision, rules: capable.body.data.settings.rules, deleteToken: capability }, memberHeaders)).status, 200);
  await pool.query('UPDATE "Query" SET "userId"=$1 WHERE id=$2', [memberId, ids[1]]);
  assert.equal((await request(ids[1], 'GET', undefined, memberHeaders)).status, 200, 'Selected owners can read their own rules');
  await pool.query('UPDATE "Query" SET "userId"=$1 WHERE id=$2', [owner.id, ids[1]]);
  const foreignContext = await browser.newContext(); await addBrowserSession(foreignContext, origin, memberToken);
  const foreignPage = await foreignContext.newPage();
  await foreignPage.goto(`${origin}/q/${ids[0]}`);
  assert.equal(await foreignPage.getByRole('button', { name: 'Price alerts', exact: true }).count(), 0);
  await foreignPage.evaluate(({ id, deleteToken }) => localStorage.setItem('ft-trackers', JSON.stringify([{ id, deleteToken }])), { id: ids[0], deleteToken: capability });
  await foreignPage.reload();
  const capableRoute = foreignPage.getByRole('region', { name: /Jun 15, 2027$/ });
  await capableRoute.getByRole('button', { name: 'Price alerts', exact: true }).click();
  const capablePanel = capableRoute.getByRole('region', { name: 'Price alert rules', exact: true });
  await capablePanel.getByRole('checkbox', { name: 'Enabled', exact: true }).waitFor();
  assert.equal(await capablePanel.getByRole('checkbox', { name: 'Enabled', exact: true }).isChecked(), false);
  await foreignContext.close();

  const latest = (await request(ids[0])).body.data.settings;
  assert.equal((await request(ids[0], 'PUT', { revision: latest.revision, rules: [] })).status, 200);
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime","scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())',
    [randomUUID(), ids[0], '2027-06-15', 200, 'USD', 'Fixture Air', flight.id, 'FA100', '08:00']);
  if (process.env.PRICE_RULES_BEFORE_ORIGIN) {
    const beforeOrigin = process.env.PRICE_RULES_BEFORE_ORIGIN;
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(beforeOrigin).hostname));
    const beforeContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await addBrowserSession(beforeContext, beforeOrigin, token);
    const beforePage = await beforeContext.newPage(); await beforePage.goto(`${beforeOrigin}/q/${ids[0]}`);
    await beforePage.getByRole('button', { name: 'Filters', exact: true }).first().waitFor();
    assert.equal(await beforePage.getByRole('button', { name: 'Price alerts', exact: true }).count(), 0);
    await beforePage.screenshot({ path: '/tmp/flight-price-rules-before.png', fullPage: true }); await beforeContext.close();
  }
  await page.goto(`${origin}/q/${ids[0]}`);
  assert.equal(await page.getByRole('button', { name: 'Price alerts', exact: true }).count(), 2);
  await openPanel(); await panel.getByRole('button', { name: 'Add rule', exact: true }).click();
  const scope = panel.getByRole('combobox', { name: 'Apply to', exact: true });
  await scope.focus(); await scope.press('f'); await scope.press('Tab');
  assert.equal(await scope.inputValue(), JSON.stringify([flight.id, 'USD']), 'Flight scope is keyboard accessible');
  await panel.getByRole('spinbutton', { name: 'Drop (%)', exact: true }).fill('10');
  await panel.getByRole('spinbutton', { name: 'Cooldown (minutes)', exact: true }).fill('30');
  await savePanel();
  let saved = (await request(ids[0])).body.data.settings;
  assert.equal(saved.rules[0].dropPct, 0.1); assert.equal(saved.rules[0].cooldownMinutes, 30);
  assert.deepEqual((await request(ids[1])).body.data.settings.rules, explicit.body.data.settings.rules, 'Grouped tracker rules stay independent');
  await page.reload(); await openPanel();
  assert.equal(await panel.getByRole('spinbutton', { name: 'Drop (%)', exact: true }).inputValue(), '10');
  await savePanel(); assert.equal((await request(ids[0])).body.data.settings.revision, saved.revision, 'Untouched UI save is a no-op');
  const exactFraction = 0.12345678901234567;
  saved = (await request(ids[0], 'PUT', { revision: saved.revision, rules: [{ ...saved.rules[0], dropPct: exactFraction }] })).body.data.settings;
  await openPanel(); await savePanel();
  assert.equal((await request(ids[0])).body.data.settings.revision, saved.revision, 'Untouched fraction keeps its exact authority');
  assert.equal((await request(ids[0])).body.data.settings.rules[0].dropPct, exactFraction);
  await openPanel(); await panel.getByRole('spinbutton', { name: 'Drop (%)', exact: true }).fill('100');
  assert.deepEqual(await panel.locator('input').evaluateAll(inputs => inputs.filter(input => !input.checkValidity()).map(input => ({ value: input.value, message: input.validationMessage, min: input.min, max: input.max, step: input.step }))), [], 'Native constraints permit validation of the 100 percent boundary');
  assert.equal(await panel.getByRole('spinbutton', { name: 'Drop (%)', exact: true }).inputValue(), '100', 'Reload must not replace a new edit');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  try { await panel.getByRole('alert').filter({ hasText: /below 100/ }).waitFor(); }
  catch (error) {
    await page.screenshot({ path: '/tmp/flight-price-rules-boundary-failure.png', fullPage: true });
    console.error('Percentage boundary page:', await page.locator('main').innerText());
    console.error('Percentage boundary settings:', JSON.stringify((await request(ids[0])).body.data.settings));
    throw error;
  }
  assert.equal((await request(ids[0])).body.data.settings.revision, saved.revision);
  await panel.getByRole('spinbutton', { name: 'Drop (%)', exact: true }).fill('10');
  const external = await request(ids[0], 'PUT', { revision: saved.revision, rules: [{ ...saved.rules[0], cooldownMinutes: 45 }] });
  assert.equal(external.status, 200);
  const stale = page.waitForResponse(response => response.url().endsWith(`/api/queries/${ids[0]}/alerts`) && response.request().method() === 'PUT');
  await panel.getByRole('button', { name: 'Save', exact: true }).click(); assert.equal((await stale).status(), 409);
  await panel.getByRole('alert').filter({ hasText: /Reload/ }).waitFor();
  assert.equal(await panel.getByRole('spinbutton', { name: 'Drop (%)', exact: true }).inputValue(), '10', 'Conflict preserves draft');
  await panel.getByRole('button', { name: 'Reload', exact: true }).click();
  await panel.getByRole('spinbutton', { name: 'Cooldown (minutes)', exact: true }).waitFor();
  assert.equal(await panel.getByRole('spinbutton', { name: 'Cooldown (minutes)', exact: true }).inputValue(), '45');
  await page.screenshot({ path: '/tmp/flight-price-rules-desktop.png', fullPage: true });
  for (const locale of ['es', 'pt', 'de', 'fr']) {
    const strings = JSON.parse(await readFile(new URL(`../../apps/web/messages/${locale}/components.json`, import.meta.url), 'utf8')).TrackerPriceRules;
    const localized = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await addBrowserSession(localized, origin, token); await localized.addCookies([{ name: 'ft-locale', value: locale, url: origin }]);
    const localPage = await localized.newPage(); localPage.on('pageerror', error => errors.push(error.message));
    await localPage.goto(`${origin}/q/${ids[0]}`);
    const localRoute = localPage.getByRole('region', { name: /Jun 15, 2027$/ });
    await localRoute.getByRole('button', { name: strings.alerts, exact: true }).click();
    const localPanel = localRoute.getByRole('region', { name: strings.rules, exact: true });
    await localPanel.getByRole('spinbutton', { name: strings.percentage, exact: true }).waitFor();
    assert.equal(await localPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale} mobile layout`);
    await localized.close();
  }
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime",status,"scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())',
    [randomUUID(), ids[0], '2027-06-15', 200, 'USD', 'Fixture Air', flight.id, 'FA100', '08:00', 'sold_out']);
  await page.reload(); await openPanel();
  assert.match(await panel.getByRole('combobox').inputValue(), /FixtureAir-FA100/);
  assert.equal(await panel.getByRole('option', { name: 'Previously selected flight (USD)', exact: true }).count(), 1);
  await panel.getByRole('checkbox', { name: 'Enabled', exact: true }).uncheck(); await savePanel();
  assert.equal((await request(ids[0])).body.data.settings.rules[0].enabled, false);
  await openPanel(); await page.setViewportSize({ width: 390, height: 844 }); await panel.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/flight-price-rules-mobile.png', fullPage: true });
  await panel.getByRole('button', { name: 'Remove rule', exact: true }).click(); await savePanel();
  assert.deepEqual((await request(ids[0])).body.data.settings.rules, []);
  const after = (await pool.query('SELECT "updatedAt" FROM "Query" WHERE id=$1', [ids[0]])).rows[0].updatedAt;
  assert.equal(after.toISOString(), before.toISOString(), 'Rule edits do not change scrape criteria authority');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "PriceSnapshot" WHERE "queryId"=ANY($1::text[])', [ids])).rows[0].count, 6, 'Rule changes preserve observation history');
  await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline,"flightId","flightNumber","departureTime","scrapedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())',
    [randomUUID(), ids[0], '2027-06-15', 200, 'USD', 'Fixture Air', flight.id, 'FA100', '08:00']);
  const empty = (await request(ids[0])).body.data.settings;
  assert.equal((await request(ids[0], 'PUT', { revision: empty.revision, rules: [{ flightId: flight.id, currency: 'USD', targetPrice: 100 }] })).status, 200);
  await pool.query('UPDATE "Query" SET currency=$1,"updatedAt"=now() WHERE id=$2', ['EUR', ids[0]]);
  await page.reload(); await openPanel();
  assert.equal(await panel.getByRole('option', { name: 'Previously selected flight (USD)', exact: true }).count(), 1, 'Stored flight remains visible after tracker currency changes');
  await panel.getByRole('button', { name: 'Use tracker currency', exact: true }).click();
  assert.equal(await panel.getByRole('textbox', { name: 'Currency', exact: true }).inputValue(), 'EUR');
  assert.equal(await panel.getByRole('spinbutton', { name: 'Target price', exact: true }).inputValue(), '', 'Old amount is not reinterpreted in a new currency');
  await panel.getByRole('spinbutton', { name: 'Target price', exact: true }).fill('120'); await savePanel();
  const rebound = (await request(ids[0])).body.data.settings.rules[0];
  assert.equal(rebound.flightId, null); assert.equal(rebound.currency, 'EUR'); assert.equal(rebound.targetPrice, 120);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "PriceSnapshot" WHERE "queryId"=ANY($1::text[])', [ids])).rows[0].count, 7);
  assert.deepEqual(errors, [], 'No browser runtime or hydration failures');
  console.log('Price-rule production browser/API/PostgreSQL acceptance passed: owner/member/capability authorization, private responses, server IDs, unchanged criteria/history, independent group rules, no-op and exact fraction revisions, conflicts, concurrent edits, foreign IDs, malformed thresholds, keyboard create/edit/pause/delete, reopened-editor validation, stale-draft recovery, unavailable flight scope, mixed currencies and explicit currency recovery, five languages and mobile.');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=ANY($1)', [ids]);
  if (memberId) {
    const removed = await fetch(`${origin}/api/admin/users/${memberId}`, { method: 'DELETE', headers });
    assert.equal(removed.status, 200, await removed.text());
  }
  if (originalMultiUser !== undefined) await pool.query('UPDATE "ExtractionConfig" SET "multiUserMode"=$1 WHERE id=$2', [originalMultiUser, 'singleton']);
  await context.close(); await browser.close();
  await pool.end();
}
