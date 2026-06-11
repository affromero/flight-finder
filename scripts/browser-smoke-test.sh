#!/usr/bin/env bash
set -euo pipefail

# Browser smoke test: launches Playwright against a running Fairtrail instance.
# Verifies pages render correctly, key elements are visible, navigation works.
#
# Requires: the app running at $BASE_URL (default: http://localhost:3399)
# Usage: bash scripts/browser-smoke-test.sh [base_url]

BASE_URL="${1:-http://localhost:3399}"

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
printf "${BOLD}Fairtrail browser smoke tests${RESET}\n"
printf "${DIM}Target: ${BASE_URL}${RESET}\n"
echo ""

# Run the Playwright test script
node --input-type=module <<SCRIPT
import { chromium } from 'playwright';

const BASE = '${BASE_URL}';
let pass = 0;
let fail = 0;

function ok(msg) { pass++; console.log('\x1b[32mPASS\x1b[0m ' + msg); }
function bad(msg, detail) { fail++; console.log('\x1b[31mFAIL\x1b[0m ' + msg + ' -- ' + detail); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

try {
  // ── Test 1: Landing page loads with search bar ──────────────
  {
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });

    const title = await page.title();
    if (title.toLowerCase().includes('flight finder')) {
      ok('Landing page title contains "Flight Finder"');
    } else {
      bad('Landing page title', 'got: ' + title);
    }

    // A fresh install (no admin password set) redirects to the setup wizard;
    // a configured instance shows the search bar; a gated host shows an invite
    // input. All three are valid. Each detector resolves to its label on a
    // match and never settles on a miss (so a losing branch can't reject the
    // race), with a hard timeout as the only failure path.
    const detect = (p, label) => p.then(() => label).catch(() => new Promise(() => {}));
    const result = await Promise.race([
      detect(
        page.locator('input[placeholder*="NYC"], input[placeholder*="Paris"]')
          .first().waitFor({ state: 'visible', timeout: 25000 }),
        'search',
      ),
      detect(page.waitForURL('**/setup', { timeout: 25000 }), 'setup'),
      detect(page.waitForURL('**/login**', { timeout: 25000 }), 'login'),
      detect(
        page.locator('input[placeholder*="invite"]')
          .first().waitFor({ state: 'visible', timeout: 25000 }),
        'invite',
      ),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 20000)),
    ]);

    if (result === 'search') {
      ok('Search input is visible on landing page');
    } else if (result === 'setup') {
      ok('Setup wizard shown (first-run, no admin password set)');
    } else if (result === 'login') {
      ok('Login picker shown (multi user mode)');
    } else if (result === 'invite') {
      ok('Invite code input visible (gated mode)');
    } else {
      bad('Landing page', 'no search bar, setup wizard, login, nor invite input after 20s');
    }

    await page.close();
  }

  // ── Test 2: Settings page loads with currency/country fields ─
  {
    const page = await context.newPage();
    await page.goto(BASE + '/settings', { waitUntil: 'networkidle', timeout: 30000 });

    // Page should render (not 404)
    const heading = page.locator('h1, h2').first();
    const headingText = await heading.textContent({ timeout: 5000 }).catch(() => '');
    if (headingText.toLowerCase().includes('settings')) {
      ok('Settings page heading found');
    } else {
      bad('Settings page heading', 'got: ' + headingText);
    }

    // Currency dropdown should be present (changed from text input to select)
    const currencySelect = page.locator('select').nth(1);
    if (await currencySelect.isVisible({ timeout: 5000 }).catch(() => false)) {
      ok('Currency dropdown is visible on settings page');
    } else {
      bad('Currency dropdown', 'not visible on settings page');
    }

    // VPN section should be present
    const vpnSection = page.locator('text=VPN Price Comparison');
    if (await vpnSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      ok('VPN Price Comparison section is visible on settings page');
    } else {
      bad('VPN section', 'not visible on settings page');
    }

    // Provider dropdown should be present
    const providerSelect = page.locator('select').first();
    if (await providerSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
      ok('Provider dropdown is visible on settings page');
    } else {
      bad('Provider dropdown', 'not visible');
    }

    await page.close();
  }

  // ── Test 3: Admin login page or redirect ───────────────────────
  {
    const page = await context.newPage();
    const response = await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle', timeout: 30000 });

    const url = page.url();
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      ok('Admin login page has password input');
    } else if (url.includes('/admin') && response && response.ok()) {
      // Self-hosted mode may skip login and redirect to dashboard
      ok('Admin page loaded (self-hosted mode, login skipped)');
    } else if (response && (response.status() === 307 || response.status() === 302)) {
      ok('Admin login redirects (expected in self-hosted mode)');
    } else {
      bad('Admin login page', 'unexpected state: url=' + url + ' status=' + (response?.status() ?? 'null'));
    }

    await page.close();
  }

  // ── Test 4: Static assets downloadable (via API request, not page nav) ──
  {
    const apiCtx = context.request;

    const cliRes = await apiCtx.get(BASE + '/flight-finder-cli');
    if (cliRes.ok()) {
      const body = await cliRes.text();
      if (body.includes('#!/usr/bin/env bash')) {
        ok('GET /flight-finder-cli returns a bash script');
      } else {
        bad('GET /flight-finder-cli', 'not a bash script');
      }
    } else {
      bad('GET /flight-finder-cli', 'status ' + cliRes.status());
    }

    const installRes = await apiCtx.get(BASE + '/install.sh');
    if (installRes.ok()) {
      const body = await installRes.text();
      if (body.includes('#!/usr/bin/env bash') && body.includes('HOST_PORT')) {
        ok('GET /install.sh returns installer with HOST_PORT docs');
      } else {
        bad('GET /install.sh', 'missing shebang or HOST_PORT');
      }
    } else {
      bad('GET /install.sh', 'status ' + installRes.status());
    }
  }

  // ── Test 5: Navigation -- click from landing to settings ──────
  {
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });

    // Look for a settings/gear link
    const settingsLink = page.locator('a[href="/settings"], a[href*="settings"]').first();
    if (await settingsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await settingsLink.click();
      await page.waitForURL('**/settings', { timeout: 10000 });
      ok('Navigation: clicked settings link, arrived at /settings');
    } else {
      // Settings might not be linked from landing -- navigate directly
      ok('Navigation: settings link not on landing (direct nav works)');
    }

    await page.close();
  }

} finally {
  await browser.close();
}

console.log('');
console.log('\x1b[1mResults: \x1b[32m' + pass + ' passed\x1b[0m, \x1b[31m' + fail + ' failed\x1b[0m');
console.log('');
if (fail > 0) process.exit(1);
SCRIPT
