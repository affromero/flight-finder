import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import pg from 'pg';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:3408';
const database = new URL(process.env.DATABASE_URL ?? '');
if (![new URL(origin), database].every(url => ['127.0.0.1', 'localhost'].includes(url.hostname))) {
  throw new Error('Use a disposable local Flight Finder instance and database');
}
const name = process.env.TEST_ACCESS_NAME;
const password = process.env.TEST_ACCESS_PASSWORD;
assert.ok(name && password, 'Initialize a disposable administrator and provide TEST_ACCESS_NAME/PASSWORD');
const token = await admitBrowserHousehold({ origin, password });
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `ft-session=${token}` };
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: name }) });
assert.equal(login.status, 200, await login.text());
const unauthorized = await fetch(`${origin}/api/admin/notifications`);
assert.ok([401, 403].includes(unauthorized.status), 'Anonymous notification access must be denied');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
await addBrowserSession(context, origin, token);
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let channelId;
async function saved(method, action) {
  const response = page.waitForResponse(response => response.url().includes('/api/admin/notifications') && response.request().method() === method);
  await action();
  return response;
}
async function listedChannel() {
  const response = await fetch(`${origin}/api/admin/notifications`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.data.channels.find(channel => channel.id === channelId);
}
try {
  await page.goto(`${origin}/admin/notifications`);
  await page.getByLabel('Type', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/flight-pushover-before.png', fullPage: true });
  await page.getByLabel('Type', { exact: true }).selectOption('pushover');
  await page.getByLabel('Label (optional)', { exact: true }).fill('Pushover browser acceptance');
  await page.getByLabel('Access token', { exact: true }).fill('a'.repeat(30));
  await page.getByLabel('User or group key', { exact: true }).fill('b'.repeat(30));
  await page.getByLabel(/Device names/).fill('phone,tablet');
  await page.getByLabel(/Priority/).fill('2');
  await page.getByLabel(/retry interval/i).fill('29');
  await page.getByLabel(/^Emergency expiry/).fill('60');
  const rejected = await saved('POST', () => page.getByRole('button', { name: 'Add channel', exact: true }).click());
  assert.equal(rejected.status(), 400, 'Emergency retry values below 30 seconds must be rejected');
  await page.getByLabel(/retry interval/i).fill('30');
  const created = await saved('POST', () => page.getByRole('button', { name: 'Add channel', exact: true }).click());
  assert.equal(created.status(), 201);
  const createdBody = await created.json();
  channelId = createdBody.data.channel.id;
  assert.equal(createdBody.data.channel.config.tokenSet, true);
  assert.equal(createdBody.data.channel.config.userKeySet, true);
  assert.equal(JSON.stringify(createdBody).includes('a'.repeat(30)), false);
  assert.equal(JSON.stringify(createdBody).includes('b'.repeat(30)), false);
  const stored = await pool.query('SELECT config FROM "NotificationChannel" WHERE id = $1', [channelId]);
  assert.notEqual(stored.rows[0].config.token, 'a'.repeat(30));
  assert.notEqual(stored.rows[0].config.userKey, 'b'.repeat(30));

  const row = page.getByRole('listitem').filter({ hasText: 'Pushover browser acceptance' });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.getByLabel('Access token', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('User or group key', { exact: true }).inputValue(), '');
  await page.getByLabel(/Device names/).fill('');
  await page.getByLabel(/Priority/).fill('');
  const edited = await saved('PATCH', () => page.getByRole('button', { name: 'Save changes', exact: true }).click());
  assert.equal(edited.status(), 200);
  const current = await listedChannel();
  assert.equal(current.config.priority, 0);
  assert.equal(current.config.device, '');
  assert.equal(current.config.tokenSet, true);
  assert.equal(current.config.userKeySet, true);
  const kept = await pool.query('SELECT config FROM "NotificationChannel" WHERE id = $1', [channelId]);
  assert.equal(kept.rows[0].config.token, stored.rows[0].config.token);
  assert.equal(kept.rows[0].config.userKey, stored.rows[0].config.userKey);

  await saved('PATCH', () => row.getByRole('button', { name: 'Disable', exact: true }).click());
  assert.equal((await listedChannel()).enabled, false);
  await page.screenshot({ path: '/tmp/flight-pushover-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile form must fit the viewport');
  await page.screenshot({ path: '/tmp/flight-pushover-mobile.png', fullPage: true });
  page.once('dialog', dialog => dialog.accept());
  const removed = await saved('DELETE', () => row.getByRole('button', { name: 'Delete', exact: true }).click());
  assert.equal(removed.status(), 200);
  assert.equal(await listedChannel(), undefined);
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log('Pushover browser/API/database acceptance passed: authorization, validation, encrypted creation, redaction, edit/clear, retained keys, disable, mobile layout, delete.');
} finally {
  if (channelId) await fetch(`${origin}/api/admin/notifications/${channelId}`, { method: 'DELETE', headers });
  await context.close();
  await browser.close();
  await pool.end();
}
