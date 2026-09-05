import type { Page } from 'playwright';
import type { HotelSource } from './types';

export async function navigateHotelPage(page: Page, url: string, source: HotelSource) {
  const providerHost = source === 'booking' ? 'www.booking.com' : 'www.google.com';
  const allowed = (destination: URL) => destination.protocol === 'https:' && !destination.port && !destination.username && !destination.password
    && (destination.hostname === providerHost || (source === 'google_hotels' && destination.hostname === 'consent.google.com'));
  let redirects = 0;
  let finalStatus = 0;
  await page.route('**/*', async route => {
    const request = route.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return route.fallback();
    const destination = new URL(request.url());
    if (!allowed(destination)) return route.abort('blockedbyclient');
    // Browser routing skips subsequent HTTP redirect hops. Fetch one hop only,
    // then initiate a fresh navigation so every destination is checked first.
    const response = await route.fetch({ maxRedirects: 0, timeout: 45000 }).catch(() => null);
    if (!response) return route.abort('failed');
    const status = response.status();
    finalStatus = status;
    const location = response.headers().location;
    if (![301, 302, 303, 307, 308].includes(status) || !location) return route.fulfill({ response });
    const next = new URL(location, destination);
    if (!allowed(next) || ++redirects > 10 || ([307, 308].includes(status) && request.method() !== 'GET')) return route.abort('blockedbyclient');
    const target = JSON.stringify(next.href).replaceAll('<', '\\u003c');
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<html data-hotel-redirect="pending"><script>location.replace(${target})</script></html>` });
  });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!response || response.status() >= 400) throw new Error(`${source} returned HTTP ${response?.status() ?? 'unknown'}`);
  await page.locator('body').waitFor({ state: 'visible' });
  await page.waitForTimeout(5000);
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-hotel-redirect'), undefined, { timeout: 45000 });
  const consentPage = source === 'google_hotels' && new URL(page.url()).hostname === 'consent.google.com';
  const reject = page.getByRole('button', { name: /^Reject all$/i }).first();
  const accept = page.getByRole('button', { name: /^(Accept all|Accept)$/i }).first();
  const consent = await reject.isVisible() ? reject : accept;
  if (consentPage) {
    if (!(await consent.isVisible())) throw new Error('Google Hotels consent could not be completed');
    try {
      await Promise.all([
        page.waitForURL(next => next.protocol === 'https:' && next.hostname === providerHost && next.pathname.startsWith('/travel/'), { timeout: 15000, waitUntil: 'domcontentloaded' }),
        consent.click(),
      ]);
    } catch { throw new Error('Google Hotels consent did not return to hotel results'); }
  } else if (await consent.isVisible()) await consent.click();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-hotel-redirect'), undefined, { timeout: 45000 });
  const final = new URL(page.url());
  if (finalStatus >= 400) throw new Error(`${source} returned HTTP ${finalStatus}`);
  if (final.protocol !== 'https:' || final.hostname !== providerHost || final.port || (source === 'google_hotels' && !final.pathname.startsWith('/travel/'))) throw new Error(`${source} did not return to an allowed hotel page`);
}
