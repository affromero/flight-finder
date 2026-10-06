import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium } from 'playwright';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['localhost', '127.0.0.1'].includes(url.hostname)), 'Use disposable local services');
assert.ok(database.port && database.pathname === '/flight_forks', 'Use the explicitly ported disposable flight_forks database');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD, 'Provide the initialized disposable owner');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
context.setDefaultTimeout(15000);
await addBrowserSession(context, origin, token);
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
const ids = [randomUUID(), randomUUID()];
const groupId = randomUUID(), capability = randomUUID();
const channelIds = [];
let memberId, originalMultiUser;

async function request(path, method = 'GET', body, requestHeaders = headers) {
  const response = await fetch(`${origin}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json();
  return { status: response.status, json, cache: response.headers.get('cache-control') };
}
const endpoint = `/api/queries/${ids[0]}/notifications`;
async function settings() {
  const result = await request(endpoint);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.ok, true);
  assert.match(result.cache, /private.*no-store/);
  return result.json.data.settings;
}
async function save(body) {
  const result = await request(endpoint, 'PATCH', body);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.data.settings;
}
const panel = page.getByRole('region', { name: 'Notification recipients', exact: true }).first();
async function openPanel() {
  await page.getByRole('button', { name: 'Notifications', exact: true }).first().click();
  await panel.getByRole('combobox', { name: 'Notification recipients' }).waitFor();
}
async function savePanel() {
  const response = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PATCH');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  await panel.waitFor({ state: 'hidden' });
}

try {
  const config = (await pool.query('SELECT enabled,"setupComplete","multiUserMode" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false, 'Disable scheduling before seeding acceptance trackers');
  assert.equal(config?.setupComplete, true);
  const login = await request('/api/auth/login', 'POST', { username: process.env.TEST_ACCESS_NAME });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  assert.ok(owner);
  originalMultiUser = config.multiUserMode;
  await pool.query('UPDATE "ExtractionConfig" SET "multiUserMode"=true WHERE id=$1', ['singleton']);
  const createdMember = await request('/api/admin/users', 'POST', { username: `subs-${randomUUID().slice(0, 8)}` });
  assert.equal(createdMember.status, 201, JSON.stringify(createdMember.json));
  memberId = createdMember.json.data.user.id;
  const memberToken = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
  const memberHeaders = { ...headers, Cookie: `ft-session=${memberToken}` };
  const memberLogin = await request('/api/auth/login', 'POST', { username: createdMember.json.data.user.username }, memberHeaders);
  assert.equal(memberLogin.status, 200, JSON.stringify(memberLogin.json));

  for (const id of ids) {
    await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","groupId","userId","deleteToken","updatedAt","firstViewedAt",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,now(),now(),false)',
      [id, 'Subscription acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', '2027-06-15', '2027-06-20', groupId, owner.id, capability]);
    await pool.query('INSERT INTO "PriceSnapshot" (id,"queryId","travelDate",price,currency,airline) VALUES ($1,$2,$3,100,$4,$5)', [randomUUID(), id, '2027-06-15', 'USD', 'Fixture Air']);
  }
  const before = (await pool.query('SELECT "updatedAt" FROM "Query" WHERE id=$1', [ids[0]])).rows[0].updatedAt;
  for (const [label, enabled] of [['Acceptance channel A', true], ['Acceptance channel B', false]]) {
    const created = await request('/api/admin/notifications', 'POST', { type: 'webhook', label, enabled, config: { url: 'http://127.0.0.1:55417/fixture', secret: 'fixture-not-a-live-key' } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    channelIds.push(created.json.data.channel.id);
  }
  const foreignId = randomUUID(); channelIds.push(foreignId);
  await pool.query('INSERT INTO "NotificationChannel" (id,"userId",type,label,config,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())', [foreignId, memberId, 'webhook', 'Foreign recipient', { url: 'http://127.0.0.1:55417/foreign' }]);
  const initial = await settings();
  assert.deepEqual([initial.mode, initial.revision, initial.channelIds], ['inherit', 0, []]);
  assert.ok(initial.channels.some(channel => channel.id === channelIds[1] && channel.enabled === false));
  assert.ok(initial.channels.every(channel => !('config' in channel) && channel.id !== foreignId));
  assert.equal((await save({ mode: 'inherit', revision: 0, channelIds: [] })).revision, 0, 'No-op keeps the event generation');
  for (const bad of [{ mode: 'selected', revision: 0, channelIds: [foreignId] }, { mode: 'inherit', revision: 0, channelIds: [], unexpected: true }]) {
    assert.equal((await request(endpoint, 'PATCH', bad)).status, 400);
  }
  const denied = await request(endpoint, 'GET', undefined, memberHeaders);
  assert.ok([401, 403].includes(denied.status), JSON.stringify(denied.json));
  assert.match(denied.cache, /private.*no-store/);
  const capable = await request(endpoint, 'GET', undefined, { ...memberHeaders, 'x-delete-token': capability });
  assert.equal(capable.status, 200, JSON.stringify(capable.json));
  const capabilityEdit = await request(endpoint, 'PATCH', { mode: 'inherit', revision: 0, channelIds: [], deleteToken: capability }, memberHeaders);
  assert.equal(capabilityEdit.status, 200);
  await pool.query('UPDATE "Query" SET "userId"=$1 WHERE id=$2', [memberId, ids[1]]);
  assert.equal((await request(`/api/queries/${ids[1]}/notifications`, 'GET', undefined, memberHeaders)).status, 200, 'Selected profiles can edit their own trackers');
  await pool.query('UPDATE "Query" SET "userId"=$1 WHERE id=$2', [owner.id, ids[1]]);
  const concurrent = await Promise.all([channelIds[0], channelIds[1]].map(id => request(endpoint, 'PATCH', { mode: 'selected', revision: 0, channelIds: [id] })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409], 'Concurrent editors cannot overwrite each other');
  await save({ mode: 'inherit', revision: 1, channelIds: [] });
  console.log('PASS real API authorization, capability, metadata redaction, validation and concurrent revision control');

  if (process.env.SUBSCRIPTIONS_BEFORE_ORIGIN) {
    const beforeOrigin = process.env.SUBSCRIPTIONS_BEFORE_ORIGIN;
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(beforeOrigin).hostname));
    const beforeContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await addBrowserSession(beforeContext, beforeOrigin, token);
    const beforePage = await beforeContext.newPage();
    await beforePage.goto(`${beforeOrigin}/q/${ids[0]}`);
    await beforePage.getByRole('button', { name: 'Filters', exact: true }).first().waitFor();
    assert.equal(await beforePage.getByRole('button', { name: 'Notifications', exact: true }).count(), 0);
    await beforePage.screenshot({ path: '/tmp/flight-subscriptions-before.png', fullPage: true });
    await beforeContext.close();
  }
  await page.goto(`${origin}/q/${ids[0]}`);
  assert.equal(await page.getByRole('button', { name: 'Notifications', exact: true }).count(), 2);
  await openPanel();
  const mode = panel.getByRole('combobox', { name: 'Notification recipients' });
  await mode.focus(); await mode.press('c'); await mode.press('Tab');
  assert.equal(await mode.inputValue(), 'selected', 'Recipients can be selected with the keyboard');
  await panel.getByRole('checkbox', { name: 'Acceptance channel A', exact: true }).check();
  await savePanel();
  assert.deepEqual((await settings()).channelIds, [channelIds[0]]);
  for (const locale of ['es', 'pt', 'de', 'fr']) {
    const strings = JSON.parse(await readFile(new URL(`../../apps/web/messages/${locale}/components.json`, import.meta.url), 'utf8')).TrackerNotifications;
    const localizedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await addBrowserSession(localizedContext, origin, token);
    await localizedContext.addCookies([{ name: 'ft-locale', value: locale, url: origin }]);
    const localizedPage = await localizedContext.newPage();
    localizedPage.on('pageerror', error => errors.push(error.message));
    await localizedPage.goto(`${origin}/q/${ids[0]}`);
    await localizedPage.getByRole('button', { name: strings.notifications, exact: true }).first().click();
    const localizedPanel = localizedPage.getByRole('region', { name: strings.recipients, exact: true }).first();
    await localizedPanel.getByRole('combobox', { name: strings.recipients }).waitFor();
    assert.equal(await localizedPanel.getByRole('checkbox', { name: 'Acceptance channel A', exact: true }).isChecked(), true);
    assert.equal(await localizedPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale} mobile layout`);
    await localizedContext.close();
  }
  assert.equal((await request(`/api/queries/${ids[1]}/notifications`)).json.data.settings.mode, 'inherit', 'Sibling trackers remain independent');
  await page.reload(); await openPanel();
  assert.equal(await panel.getByRole('checkbox', { name: 'Acceptance channel A', exact: true }).isChecked(), true);
  await page.screenshot({ path: '/tmp/flight-subscriptions-desktop.png', fullPage: true });
  await panel.getByRole('checkbox', { name: 'Acceptance channel A', exact: true }).uncheck();
  await savePanel();
  assert.deepEqual([...(await settings()).channelIds], [], 'An explicit empty selection mutes this tracker');

  await openPanel();
  const current = await settings();
  await save({ mode: 'selected', revision: current.revision, channelIds: [channelIds[1]] });
  const staleResponse = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'PATCH');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await staleResponse).status(), 409);
  await panel.getByRole('alert').filter({ hasText: /Reload/i }).waitFor();
  await panel.getByRole('button', { name: 'Reload', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Acceptance channel B (Disabled)', exact: true }).waitFor();
  assert.equal(await panel.getByRole('checkbox', { name: 'Acceptance channel B (Disabled)', exact: true }).isChecked(), true);
  assert.equal((await request(`/api/admin/notifications/${channelIds[1]}`, 'DELETE')).status, 200);
  await page.reload(); await openPanel();
  await panel.getByRole('button', { name: 'Remove unavailable channels', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Acceptance channel A', exact: true }).check();
  await savePanel(); await openPanel();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile controls fit the viewport');
  await page.screenshot({ path: '/tmp/flight-subscriptions-mobile.png', fullPage: true });
  assert.deepEqual((await settings()).channelIds, [channelIds[0]]);
  assert.deepEqual((await pool.query('SELECT "updatedAt" FROM "Query" WHERE id=$1', [ids[0]])).rows[0].updatedAt, before, 'Recipient changes preserve scrape criteria generation');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "PriceSnapshot" WHERE "queryId"=ANY($1::text[])', [ids])).rows[0].count, 2);
  assert.deepEqual(errors, [], 'No browser runtime or hydration failures');
  console.log('PASS browser keyboard selection, persistence, independent trackers, explicit mute, stale-editor recovery, removed-channel recovery, mobile, unchanged history and hydration');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM "NotificationChannel" WHERE id=ANY($1::text[])', [channelIds]);
  if (memberId) {
    const removed = await request(`/api/admin/users/${memberId}`, 'DELETE');
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
  }
  if (originalMultiUser !== undefined) await pool.query('UPDATE "ExtractionConfig" SET "multiUserMode"=$1 WHERE id=$2', [originalMultiUser, 'singleton']);
  await context.close(); await browser.close(); await pool.end();
}
