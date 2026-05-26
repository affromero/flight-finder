/* eslint-disable */
// One-shot screenshot harness for the accounts feature.
// Walks through setup wizard, enables multi user mode, then captures every
// account-related page. Runs against a live dev server at BASE_URL.
//
// Usage:
//   BASE_URL=http://localhost:3004 \
//     node scripts/screenshot-accounts.mjs
//
// Output: assets/accounts/*.png

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'assets', 'accounts');
const BASE = process.env.BASE_URL || 'http://localhost:3004';

const VIEWPORT = { width: 1280, height: 800 };
const ADMIN_USER = 'andres';
const ADMIN_PASS = 'household-pass-123';
const ADMIN_DISPLAY = 'Andres';
const PARTNER_USER = 'partner';
const PARTNER_PASS = 'partner-pass-123';
const PARTNER_DISPLAY = 'Partner';

const shots = [];
async function shot(page, name, opts = {}) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  shots.push(name);
  console.log(`  → ${name}.png`);
}

async function delay(ms) { await new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();

  // 1. Setup wizard self hosted: step 1 (Provider), 2 (Community), 3 (Accounts).
  console.log('Setup wizard ...');
  await page.goto(`${BASE}/setup`);
  await page.waitForSelector('text=Flight Finder Setup');
  await shot(page, '01-setup-step1-provider');

  // Pick the anthropic provider card if visible, otherwise any provider.
  const providerCard = page.locator('button:has-text("Anthropic")').first();
  if (await providerCard.count()) await providerCard.click();
  await page.locator('button:has-text("Next")').click();
  await page.waitForSelector('text=Help build the world');
  await shot(page, '02-setup-step2-community');

  // Self hosted advances to step 3 instead of finalizing.
  await page.locator('button:has-text("Next")').click();
  await page.waitForSelector('text=Run Flight Finder for a household');
  await shot(page, '03-setup-step3-accounts-skip');

  // Toggle on, fill in admin form, screenshot, then complete.
  await page.locator('button:has-text("Skip")').click();
  await page.waitForSelector('input[placeholder^="Admin username"]');
  await page.fill('input[placeholder^="Admin username"]', ADMIN_USER);
  await page.fill('input[placeholder^="Display name"]', ADMIN_DISPLAY);
  await page.fill('input[placeholder^="Admin password"]', ADMIN_PASS);
  await shot(page, '04-setup-step3-accounts-fill');

  await page.locator('button:has-text("Complete setup")').click();
  await page.waitForURL(/\/login/, { timeout: 15000 });
  await page.waitForSelector('input[placeholder="Username"]');
  await shot(page, '05-login-empty');

  // 2. Sign in as admin.
  console.log('Admin login ...');
  await page.fill('input[placeholder="Username"]', ADMIN_USER);
  await page.fill('input[placeholder="Password"]', ADMIN_PASS);
  await page.locator('button:has-text("Sign in")').click();
  // Setup left next=/ on the login URL, so we land on the home page first.
  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), null, { timeout: 15000 });
  await page.goto(`${BASE}/admin`);
  await page.waitForSelector('a:has-text("Users")');
  await shot(page, '06-admin-dashboard-with-users-link');

  // 3. Admin Users page — empty (just admin) + backfill banner.
  console.log('Admin users page ...');
  await page.goto(`${BASE}/admin/users`);
  await page.waitForSelector('text=Users');
  await shot(page, '07-admin-users-empty', { fullPage: true });

  // Add a partner user via the form.
  await page.fill('input[placeholder="Username"]', PARTNER_USER);
  await page.fill('input[placeholder="Display name (optional)"]', PARTNER_DISPLAY);
  await page.fill('input[placeholder^="Password"]', PARTNER_PASS);
  await shot(page, '08-admin-users-add-form');
  await page.locator('button:has-text("Add user")').click();
  await page.waitForSelector(`text=@${PARTNER_USER}`);
  await shot(page, '09-admin-users-with-partner', { fullPage: true });

  // 4. Settings page multi user section (already enabled).
  console.log('Settings page ...');
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('text=Multi user mode');
  await page.locator('h2:has-text("Multi user mode")').scrollIntoViewIfNeeded();
  await shot(page, '10-settings-multi-user-enabled');

  // 5. Account pages — switch to partner.
  console.log('Partner login ...');
  // Log out by hitting /api/auth/logout
  await context.request.post(`${BASE}/api/auth/logout`);
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.fill('input[placeholder="Username"]', PARTNER_USER);
  await page.fill('input[placeholder="Password"]', PARTNER_PASS);
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForURL(/\/account$/, { timeout: 15000 });
  await page.waitForSelector('text=No trackers yet');
  await shot(page, '11-account-empty-partner', { fullPage: true });

  // Settings page for partner.
  await page.goto(`${BASE}/account/settings`);
  await page.waitForSelector('text=Account settings');
  await shot(page, '12-account-settings-partner', { fullPage: true });

  // 6. Landing welcome line as logged in user.
  console.log('Landing page logged in ...');
  await page.goto(`${BASE}/`);
  await page.waitForSelector('text=Signed in as');
  await shot(page, '13-landing-signed-in');

  await browser.close();
  console.log('\nDone. Captured', shots.length, 'screenshots in', OUT_DIR);
})();
