import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.ok([new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Use disposable local services');
assert.ok(database.port && database.pathname === '/flight_forks', 'Use the explicitly ported disposable flight_forks database');
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD, 'Provide the initialized disposable owner');
const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: process.env.TEST_ACCESS_NAME }) });
assert.equal(login.status, 200, await login.text());
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const received = [];
const gateway = createServer((request, response) => {
  let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    received.push({ path: request.url, apiKey: request.headers['x-api-key'], body: JSON.parse(body) });
    response.writeHead(request.url.includes('/groups/') ? 503 : 200);
    response.end('fixture-gateway-key');
  });
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}/fixture`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
context.setDefaultTimeout(15000);
await addBrowserSession(context, origin, token);
const page = await context.newPage(), errors = [], channelIds = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
const queryId = randomUUID();
const row = page.getByRole('listitem').filter({ hasText: 'WhatsApp browser acceptance' });
async function request(path, method = 'GET', body) {
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function saved(method, action) {
  const response = page.waitForResponse(response => response.url().includes('/api/admin/notifications') && response.request().method() === method);
  await action(); return response;
}
async function listedChannel(id) {
  const result = await request('/api/admin/notifications');
  assert.equal(result.status, 200);
  return result.body.data.channels.find(channel => channel.id === id);
}
try {
  const config = (await pool.query('SELECT enabled,"setupComplete" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(config?.enabled, false, 'Disable scheduling before adding test channels and trackers');
  assert.equal(config?.setupComplete, true);
  const denied = await fetch(`${origin}/api/admin/notifications`);
  assert.ok([401, 403].includes(denied.status));
  if (process.env.WHATSAPP_BEFORE_ORIGIN) {
    const beforeOrigin = process.env.WHATSAPP_BEFORE_ORIGIN;
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(beforeOrigin).hostname));
    const beforeContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await addBrowserSession(beforeContext, beforeOrigin, token);
    const beforePage = await beforeContext.newPage();
    await beforePage.goto(`${beforeOrigin}/admin/notifications`);
    await beforePage.getByLabel('Type', { exact: true }).waitFor();
    assert.equal(await beforePage.getByLabel('Type', { exact: true }).locator('option[value="whatsapp"]').count(), 0);
    await beforePage.screenshot({ path: '/tmp/flight-whatsapp-before.png', fullPage: true });
    await beforeContext.close();
  }
  await page.goto(`${origin}/admin/notifications`);
  await page.getByLabel('Type', { exact: true }).selectOption('whatsapp');
  await page.getByLabel('Label (optional)', { exact: true }).fill('WhatsApp browser acceptance');
  await page.getByLabel('Gateway URL', { exact: true }).fill(gatewayUrl);
  await page.getByLabel('Gateway API key', { exact: true }).fill('fixture-gateway-key');
  await page.getByLabel('Gateway account', { exact: true }).fill('fixture-account');
  const destination = page.getByLabel(/^Phone number/);
  await destination.fill('573001234567');
  assert.equal(await page.getByLabel('Destination type', { exact: true }).inputValue(), 'phone');
  assert.equal(await page.getByLabel('Flight alert language', { exact: true }).inputValue(), 'en');
  assert.equal(await page.getByLabel('Include tracker link', { exact: true }).isChecked(), false);
  const invalid = await saved('POST', () => page.getByRole('button', { name: 'Add channel', exact: true }).click());
  assert.equal(invalid.status(), 400);
  await destination.fill('+573001234567');
  const created = await saved('POST', () => page.getByRole('button', { name: 'Add channel', exact: true }).click());
  assert.equal(created.status(), 201, await created.text());
  const body = await created.json(); const id = body.data.channel.id; channelIds.push(id);
  for (const field of ['apiKey', 'account', 'destination']) assert.equal(body.data.channel.config[`${field}Set`], true);
  assert.ok(!JSON.stringify(body).includes('fixture-gateway-key') && !JSON.stringify(body).includes('+573001234567') && !JSON.stringify(body).includes('fixture-account'));
  const stored = (await pool.query('SELECT config FROM "NotificationChannel" WHERE id=$1', [id])).rows[0].config;
  assert.notEqual(stored.apiKey, 'fixture-gateway-key'); assert.notEqual(stored.account, 'fixture-account'); assert.notEqual(stored.destination, '+573001234567');
  const tested = await saved('POST', () => row.getByRole('button', { name: 'Send test', exact: true }).click());
  assert.equal(tested.status(), 200, await tested.text());
  assert.equal(received.length, 1);
  assert.deepEqual({ path: received[0].path, apiKey: received[0].apiKey, account: received[0].body.account, phone: received[0].body.phone },
    { path: '/fixture/api/messages/send', apiKey: 'fixture-gateway-key', account: 'fixture-account', phone: '+573001234567' });
  assert.ok(received[0].body.message.includes('Flight Finder test alert'));
  assert.ok(!received[0].body.message.includes(origin));

  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  for (const label of ['Gateway API key', 'Gateway account']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '');
  assert.equal(await destination.inputValue(), '');
  await page.getByLabel('Flight alert language', { exact: true }).selectOption('es');
  const edited = await saved('PATCH', () => page.getByRole('button', { name: 'Save changes', exact: true }).click());
  assert.equal(edited.status(), 200, await edited.text());
  const kept = (await pool.query('SELECT config FROM "NotificationChannel" WHERE id=$1', [id])).rows[0].config;
  for (const field of ['apiKey', 'account', 'destination']) assert.equal(kept[field], stored[field]);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Destination type', { exact: true }).selectOption('group');
  const staleDestination = await saved('PATCH', () => page.getByRole('button', { name: 'Save changes', exact: true }).click());
  assert.equal(staleDestination.status(), 400, 'Changing type requires a fresh destination');
  await destination.fill('fixture@g.us');
  await page.getByLabel('Include tracker link', { exact: true }).check();
  const group = await saved('PATCH', () => page.getByRole('button', { name: 'Save changes', exact: true }).click());
  assert.equal(group.status(), 200, await group.text());
  assert.equal((await listedChannel(id)).config.destinationType, 'group');
  assert.equal((await listedChannel(id)).config.includeTrackerLink, true);
  const failedGroup = await request('/api/admin/notifications', 'POST', { type: 'whatsapp', label: 'WhatsApp failed fixture', config: {
    gatewayUrl, apiKey: 'fixture-gateway-key', account: 'fixture-account', destinationType: 'group', destination: 'failed@g.us',
  } });
  assert.equal(failedGroup.status, 201, JSON.stringify(failedGroup.body));
  const failedId = failedGroup.body.data.channel.id; channelIds.push(failedId);
  const failedSend = await request(`/api/admin/notifications/${failedId}/test`, 'POST');
  assert.equal(failedSend.status, 502);
  assert.match(failedSend.body.error, /HTTP 503/);
  assert.ok(!JSON.stringify(failedSend.body).includes('fixture-gateway-key'));
  assert.equal(received.at(-1).path, '/fixture/api/groups/send-message');
  assert.equal(received.at(-1).body.groupId, 'failed@g.us');
  assert.equal((await request(`/api/admin/notifications/${failedId}`, 'DELETE')).status, 200);
  await page.reload(); await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.screenshot({ path: '/tmp/flight-whatsapp-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Gateway URL', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/flight-whatsapp-mobile.png', fullPage: true });

  const owner = (await pool.query('SELECT id FROM "User" WHERE username=$1', [process.env.TEST_ACCESS_NAME])).rows[0];
  await pool.query('INSERT INTO "Query" (id,"rawInput",origin,"originName",destination,"destinationName","dateFrom","dateTo","expiresAt","userId","updatedAt","firstViewedAt",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,now(),now(),false)',
    [queryId, 'WhatsApp recipient acceptance', 'JFK', 'New York', 'LAX', 'Los Angeles', '2027-06-15', '2027-06-20', owner.id]);
  await page.goto(`${origin}/q/${queryId}`);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Notification recipients', exact: true });
  await panel.getByRole('combobox').selectOption('selected');
  await panel.getByRole('checkbox', { name: 'WhatsApp browser acceptance', exact: true }).check();
  const recipientResponse = page.waitForResponse(response => response.url().endsWith(`/api/queries/${queryId}/notifications`) && response.request().method() === 'PATCH');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await recipientResponse).status(), 200);
  const settings = await request(`/api/queries/${queryId}/notifications`);
  assert.deepEqual(settings.body.data.settings.channelIds, [id]);
  assert.ok(!JSON.stringify(settings.body).includes('fixture-account') && !JSON.stringify(settings.body).includes('fixture@g.us'));

  for (const locale of ['es', 'pt', 'de', 'fr']) {
    const strings = JSON.parse(await readFile(new URL(`../../apps/web/messages/${locale}/admin.json`, import.meta.url), 'utf8')).AdminNotifications;
    const localized = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await addBrowserSession(localized, origin, token); await localized.addCookies([{ name: 'ft-locale', value: locale, url: origin }]);
    const localPage = await localized.newPage(); localPage.on('pageerror', error => errors.push(error.message));
    await localPage.goto(`${origin}/admin/notifications`);
    await localPage.getByLabel(strings.form.type, { exact: true }).selectOption('whatsapp');
    await localPage.getByLabel(strings.fields.gatewayUrl, { exact: true }).waitFor();
    assert.equal(await localPage.getByLabel(strings.fields.destinationType, { exact: true }).inputValue(), 'phone');
    assert.equal(await localPage.getByLabel(strings.fields.locale, { exact: true }).inputValue(), 'en');
    assert.equal(await localPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale} mobile layout`);
    await localized.close();
  }
  assert.deepEqual(errors, [], 'No browser runtime or hydration failures');
  console.log('WhatsApp production browser/API/PostgreSQL/local gateway acceptance passed: authorization, encrypted credentials and recipients, redaction, default form values, phone and group protocol, errors without secret bodies, retained secrets, type-change validation, opt-in links, tracker subscriptions, five languages and mobile.');
} finally {
  await pool.query('DELETE FROM "Query" WHERE id=$1', [queryId]);
  for (const id of channelIds) await request(`/api/admin/notifications/${id}`, 'DELETE');
  await context.close(); await browser.close(); await pool.end();
  gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
}
