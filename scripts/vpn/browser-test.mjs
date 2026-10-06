import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pg from 'pg';
import { initial, executable } from './tailscale-fixture.mjs';
import { admitBrowserHousehold, addBrowserSession } from '../access-browser-test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:3410';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55448'); assert.ok(['/flight_forks', '/vpn_browser_test'].includes(database.pathname));
assert.ok(process.env.TEST_ACCESS_NAME && process.env.TEST_ACCESS_PASSWORD);
const beforeMode = process.env.VPN_BROWSER_BEFORE_DIRECTORY;
const pool = new pg.Pool({ connectionString: database.href });
const directory = await mkdtemp(join(tmpdir(), 'flight-vpn-browser-'));
const screenshots = join(root, 'docs/contributors/screenshots');
let bridge, web, browser, original, page, headers;
const errors = [];
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function waitFor(work) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Fixture startup did not settle');
}
try {
  original = (await pool.query('SELECT "vpnProvider","vpnCountries","vpnActivationCode",enabled,"setupComplete" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0];
  assert.equal(original?.enabled, false); assert.equal(original?.setupComplete, true);
  await pool.query('UPDATE "ExtractionConfig" SET "vpnProvider"=NULL,"vpnCountries"=ARRAY[]::text[],"vpnActivationCode"=NULL WHERE id=$1', ['singleton']);
  for (const name of ['tailscale', 'curl']) await writeFile(join(directory, name), '#!' + process.execPath + '\n' + executable, { mode: 0o700 });
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ status: initial() }));
  bridge = spawn(process.execPath, [join(root, 'scripts/vpn/tailscale-vpn-bridge.mjs')], {
    env: { ...process.env, PATH: directory + ':' + process.env.PATH, VPN_FIXTURE_DIRECTORY: directory, VPN_BRIDGE_PORT: '0',
      TAILSCALE_VPN_SOCKS_URL: 'socks5://tailscale:1055', TAILSCALE_SOCKET: join(directory, 'dedicated.sock') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('Bridge startup timed out: ' + output)), 5000);
    bridge.stderr.on('data', chunk => { output += chunk; });
    bridge.stdout.on('data', chunk => {
      output += chunk; const match = /listening on port (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolveEndpoint('http://127.0.0.1:' + match[1]); }
    });
    bridge.once('error', error => { clearTimeout(timer); reject(error); });
    bridge.once('exit', code => { clearTimeout(timer); reject(Error('Bridge exited ' + code + ': ' + output)); });
  });
  let serverOutput = '';
  web = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--port', '3410', '--hostname', '127.0.0.1'], {
    cwd: join(beforeMode ? resolve(beforeMode) : root, 'apps/web'),
    env: { ...process.env, NODE_ENV: 'production', SELF_HOSTED: 'true', CRON_ENABLED: 'false', APP_URL: origin,
      TAILSCALE_VPN_API_URL: endpoint, TAILSCALE_VPN_SOCKS_URL: 'socks5://tailscale:1055', EXPRESSVPN_API_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', chunk => { serverOutput += chunk; }); web.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitFor(async () => {
    if (web.exitCode !== null) throw Error('Production server exited: ' + serverOutput);
    try { return (await fetch(origin + '/api/health')).ok; } catch { return false; }
  });
  const token = await admitBrowserHousehold({ origin, password: process.env.TEST_ACCESS_PASSWORD });
  headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: 'ft-session=' + token };
  assert.equal((await fetch(origin + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: process.env.TEST_ACCESS_NAME }) })).status, 200);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.setDefaultTimeout(15_000); await addBrowserSession(context, origin, token);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/hydration|did not match|server rendered|minified react/i.test(message.text())) errors.push(message.text()); });
  await page.goto(origin + '/settings'); await page.getByRole('heading', { name: 'VPN Price Comparison' }).waitFor();
  const section = page.locator('div').filter({ has: page.getByRole('heading', { name: 'VPN Price Comparison', exact: true }) }).filter({ has: page.locator('#vpn-activation-input') }).last();
  await mkdir(screenshots, { recursive: true });
  if (beforeMode) {
    await section.screenshot({ path: join(screenshots, 'flight-mullvad-before.png') });
    console.log('PASS baseline VPN settings screenshot');
  } else {
    await page.getByLabel('VPN provider').selectOption('mullvad');
    await page.getByLabel('Comparison countries').fill('ZA');
    await page.getByRole('button', { name: 'Save VPN preferences' }).click();
    await page.getByText('Use two-letter country codes with supported browser profiles for Mullvad.').waitFor();
    assert.equal((await pool.query('SELECT "vpnProvider" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0].vpnProvider, null);
    await page.getByLabel('Comparison countries').fill(' us, DE, us ');
    await page.locator('#vpn-activation-input').fill('browser-fixture-activation-not-a-live-code');
    let releaseResponse, reached;
    const paused = new Promise(resolvePaused => { reached = resolvePaused; });
    const release = new Promise(resolveRelease => { releaseResponse = resolveRelease; });
    await page.route('**/api/admin/config', async route => {
      if (route.request().method() !== 'PATCH' || route.request().postDataJSON().vpnProvider !== 'mullvad') { await route.continue(); return; }
      const response = await route.fetch(); assert.equal(response.status(), 200, await response.text()); reached();
      await release; await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Save VPN preferences' }).click(); await paused;
    assert.equal(await page.getByRole('button', { name: 'Save Code', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal((await pool.query('SELECT "vpnProvider" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0].vpnProvider, 'mullvad');
    releaseResponse(); await page.getByText('VPN ready: DE, US', { exact: true }).waitFor(); await page.unroute('**/api/admin/config');
    assert.equal(await page.getByLabel('VPN provider').inputValue(), 'mullvad');
    assert.equal(await page.getByLabel('Comparison countries').inputValue(), 'US, DE');
    assert.deepEqual((await pool.query('SELECT "vpnCountries" FROM "ExtractionConfig" WHERE id=$1', ['singleton'])).rows[0].vpnCountries, ['US', 'DE']);
    assert.equal(await section.getByText('Connected', { exact: true }).count(), 0, 'Mullvad readiness must not mark ExpressVPN connected');
    await page.route('**/api/admin/config', async route => {
      if (route.request().method() === 'PATCH' && route.request().postDataJSON().provider) { await route.abort('failed'); return; }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Failed to fetch', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Save Code', exact: true }).isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Save VPN preferences' }).isDisabled(), false);
    await page.unroute('**/api/admin/config');
    await page.locator('#vpn-activation-input').fill('');
    await section.screenshot({ path: join(screenshots, 'flight-mullvad-desktop.png') });
    await page.setViewportSize({ width: 390, height: 1200 }); await section.screenshot({ path: join(screenshots, 'flight-mullvad-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.reload(); await page.getByLabel('VPN provider').waitFor(); assert.equal(await page.getByLabel('VPN provider').inputValue(), 'mullvad');
    await page.getByText('VPN ready: DE, US', { exact: true }).waitFor();
    await page.locator('#vpn-activation-input').fill('browser-fixture-activation-not-a-live-code');
    await page.getByRole('button', { name: 'Save Code', exact: true }).click();
    await page.getByText('Preferences saved. VPN readiness could not be verified; check the sidecar and device access.').waitFor();
    assert.equal(await page.getByLabel('VPN provider').inputValue(), 'expressvpn');
    await page.getByLabel('VPN provider').selectOption('mullvad'); await page.getByRole('button', { name: 'Save VPN preferences' }).click();
    await page.getByText('VPN ready: DE, US', { exact: true }).waitFor();
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ status: initial(), malformed: true }));
    const failed = (await (await fetch(origin + '/api/vpn/status', { headers })).json()).data;
    assert.equal(failed.ready, false); assert.ok(failed.error); assert.equal(JSON.stringify(failed).includes('private daemon output'), false);
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ status: initial() }));
    for (const locale of ['es', 'de', 'fr', 'pt']) {
      await context.addCookies([{ name: 'ft-locale', value: locale, url: origin }]);
      const messages = JSON.parse(await readFile(join(root, 'apps/web/messages', locale, 'settings.json'), 'utf8')).Settings.vpn;
      await page.reload(); await page.getByLabel(messages.providerLabel).waitFor();
      assert.equal(await page.getByLabel(messages.providerLabel).inputValue(), 'mullvad');
      await page.getByRole('button', { name: messages.savePreferences }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    }
    assert.deepEqual(errors, []);
    console.log('PASS production VPN settings, actual API and PostgreSQL, delayed-response save fencing, unavailable countries, provider switching, explicit readiness failures and five localized mobile layouts');
  }
} catch (error) {
  if (page) await page.screenshot({ path: '/tmp/flight-mullvad-browser-failure.png', fullPage: true }).catch(() => undefined);
  if (headers) {
    const status = await fetch(origin + '/api/vpn/status', { headers }).then(response => response.json()).catch(() => null);
    console.error('Fixture VPN readiness:', JSON.stringify(status));
  }
  throw error;
} finally {
  await browser?.close(); await stop(web); await stop(bridge);
  if (original) await pool.query('UPDATE "ExtractionConfig" SET "vpnProvider"=$1,"vpnCountries"=$2,"vpnActivationCode"=$3 WHERE id=$4', [original.vpnProvider, original.vpnCountries, original.vpnActivationCode, 'singleton']);
  await pool.end(); await rm(directory, { recursive: true, force: true });
}
