import type { Page } from 'playwright';
import { launchBrowser, createStealthContext } from './browser';
import { getAirlineUrl } from './airline-urls';
import type { CountryProfile } from './country-profiles';

/** Random delay between min and max milliseconds */
function randomDelay(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

/** Simulate human-like page interaction: mouse moves, scrolls, pauses */
async function simulateHumanBehavior(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };

  // Move mouse to a random spot (humans don't leave cursor at 0,0)
  await page.mouse.move(
    100 + Math.random() * (viewport.width - 200),
    100 + Math.random() * (viewport.height - 200),
    { steps: 5 + Math.floor(Math.random() * 10) }
  );
  await randomDelay(200, 600);

  // Scroll down slightly like a human scanning results
  await page.mouse.wheel(0, 100 + Math.random() * 300);
  await randomDelay(300, 800);

  // Move mouse again
  await page.mouse.move(
    100 + Math.random() * (viewport.width - 200),
    200 + Math.random() * (viewport.height - 400),
    { steps: 3 + Math.floor(Math.random() * 8) }
  );
  await randomDelay(100, 400);
}

export interface FlightSearchParams {
  origin: string;
  destination: string;
  dateFrom: Date;
  dateTo: Date;
  cabinClass?: string;
  tripType?: string; // 'one_way' | 'round_trip'
  currency?: string | null; // ISO 4217 code. null = omit (Google auto-detects)
  country?: string | null; // ISO 3166-1 alpha-2. null = omit (Google auto-detects)
}

export type NavigationSource = 'google_flights' | 'airline_direct';

export interface NavigationResult {
  html: string;
  url: string;
  resultsFound: boolean;
  source: NavigationSource;
}

function buildQueryString(params: FlightSearchParams): string {
  const qs = ['hl=en'];
  if (params.currency) qs.push(`curr=${params.currency}`);
  if (params.country) qs.push(`gl=${params.country}`);
  return qs.join('&');
}

export function buildGoogleFlightsUrl(params: FlightSearchParams): string {
  // Verbose phrase form. For one-way searches we omit "+to+${dateTo}" — Google
  // Flights' NLU misparses "on YYYY-MM-DD to YYYY-MM-DD" for less-trafficked
  // airport codes (e.g. BDS, BRI) and falls back to the bare homepage. See #65.
  const dateFrom = params.dateFrom.toISOString().split('T')[0];
  const dateTo = params.dateTo.toISOString().split('T')[0];
  const oneWay = params.tripType === 'one_way';
  const oneWayPrefix = oneWay ? 'one+way+' : '';
  const datePart = oneWay ? `+on+${dateFrom}` : `+on+${dateFrom}+to+${dateTo}`;

  return `https://www.google.com/travel/flights?q=${oneWayPrefix}flights+from+${params.origin}+to+${params.destination}${datePart}&${buildQueryString(params)}`;
}

/**
 * Build alternative Google Flights URL formats. The verbose `q=` text URL
 * (buildGoogleFlightsUrl) is what humans land on, but it depends on Google's
 * NLU and is unreliable for less-trafficked airport codes. Each candidate is
 * a text URL that *carries the requested dates* — we deliberately avoid the
 * `/travel/flights/flights-from-X-to-Y.html` SEO path because it omits dates
 * and trip type, and Google fills it with defaults that would silently write
 * snapshots for the wrong travelDate.
 */
export function buildGoogleFlightsUrlCandidates(params: FlightSearchParams): string[] {
  const dateFrom = params.dateFrom.toISOString().split('T')[0];
  const dateTo = params.dateTo.toISOString().split('T')[0];
  const oneWay = params.tripType === 'one_way';
  const qs = buildQueryString(params);

  // Variant 1: verbose phrase, fixed for one-way (above).
  const verbose = buildGoogleFlightsUrl(params);

  // Variant 2: terse codes + date — fewer NLU tokens for Google to misinterpret.
  const terseDate = oneWay ? `+${dateFrom}` : `+${dateFrom}+to+${dateTo}`;
  const terse = `https://www.google.com/travel/flights?q=${params.origin}+to+${params.destination}${terseDate}&${qs}`;

  // Variant 3: reworded phrase — different verb ("departing"/"returning") and
  // a different word order put the airport codes adjacent to the keywords
  // Google's NLU is most confident about, while still carrying the date(s).
  const oneWayPrefix = oneWay ? 'one+way+' : '';
  const dateClause = oneWay
    ? `departing+${dateFrom}`
    : `departing+${dateFrom}+returning+${dateTo}`;
  const reworded = `https://www.google.com/travel/flights?q=${oneWayPrefix}flights+to+${params.destination}+from+${params.origin}+${dateClause}&${qs}`;

  return [verbose, terse, reworded];
}

export async function navigateGoogleFlights(
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string
): Promise<NavigationResult> {
  // Rotate URL formats per attempt — text URLs are unreliable for less-common
  // airport codes (#65), so retrying the same URL only ever hits the same
  // homepage redirect. Each attempt tries a structurally different URL.
  const urlCandidates = buildGoogleFlightsUrlCandidates(params);
  const maxAttempts = urlCandidates.length;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = urlCandidates[attempt - 1]!;
    const browser = await launchBrowser({ proxyUrl });
    const attemptStart = Date.now();

    try {
      const context = await createStealthContext(browser, { countryProfile, proxyUrl });
      const page = await context.newPage();
      console.log(`[navigate] attempt ${attempt}/${maxAttempts} → ${url}`);

      const gotoStart = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`[navigate] goto resolved in ${Date.now() - gotoStart}ms`);

      // Wait for page to settle — randomized to look human
      await randomDelay(attempt === 1 ? 2000 : 4000, attempt === 1 ? 4000 : 7000);

      // Dismiss consent/cookie dialog — Google renders two identical "Accept all"
      // buttons; without .first() Playwright strict mode throws on the ambiguity
      try {
        const consentButton = page.locator('button:has-text("Accept all")').first();
        if (await consentButton.isVisible({ timeout: 2000 })) {
          await consentButton.click();
          await randomDelay(2000, 4000);
        }
      } catch {
        // No consent dialog — continue
      }

      // Wait for flight results — look for price elements
      let resultsFound = false;
      try {
        const selectorStart = Date.now();
        await page.waitForSelector('[data-gs]', { timeout: 15_000 });
        console.log(`[navigate] selector [data-gs] found in ${Date.now() - selectorStart}ms`);
        resultsFound = true;
      } catch {
        console.log(`[navigate] selector [data-gs] not found after 15s`);
      }

      // Simulate human behavior only after results load — reduces time
      // the page spends accumulating resources before we extract data
      if (resultsFound) {
        await simulateHumanBehavior(page);
      }

      // Capture visible text instead of raw HTML — Google Flights pages are 2-3MB
      // of HTML but only ~3k of visible text, and flight data starts deep in the DOM
      // where a 50k char cap would never reach it
      const html = await page.evaluate(() => document.body.innerText);
      console.log(`[navigate] attempt ${attempt}: resultsFound=${resultsFound}, textLength=${html.length}, elapsed=${Date.now() - attemptStart}ms`);

      await context.close();

      // Retry with fresh browser if no results and we have attempts left
      if (!resultsFound && attempt < maxAttempts) {
        console.log(`[navigate] no results on attempt ${attempt}, retrying after delay…`);
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
        continue;
      }

      return { html, url, resultsFound, source: 'google_flights' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isCrash = /crashed|target closed|disposed/i.test(message);
      console.error(`[navigate] attempt ${attempt} failed (crash=${isCrash}, elapsed=${Date.now() - attemptStart}ms): ${message}`);

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
        continue;
      }
      throw error;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // Unreachable — loop always returns — but TypeScript needs it
  throw new Error('navigateGoogleFlights: exhausted all attempts');
}

export interface FlightDetailResult {
  airlineDirectPrice: number | null;
  airlineDirectCurrency: string | null;
  bookingUrl: string | null;
  allBookingOptions: Array<{
    provider: string;
    isAirline: boolean;
    price: number;
    currency: string;
  }>;
}

export async function navigateFlightDetail(
  params: FlightSearchParams,
  flightIndex: number,
  countryProfile?: CountryProfile,
  proxyUrl?: string
): Promise<FlightDetailResult> {
  const browser = await launchBrowser({ proxyUrl });
  const start = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();

    // Must use one-way search so clicking goes directly to booking options
    const url = buildGoogleFlightsUrl({ ...params, tripType: 'one_way' });
    console.log(`[navigate:detail] → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log(`[navigate:detail] goto resolved in ${Date.now() - gotoStart}ms`);

    await randomDelay(2000, 4000);

    // Dismiss consent
    try {
      const consentButton = page.locator('button:has-text("Accept all")').first();
      if (await consentButton.isVisible({ timeout: 2000 })) {
        await consentButton.click();
        await randomDelay(2000, 4000);
      }
    } catch {
      // No consent dialog
    }

    // Wait for results
    try {
      const selectorStart = Date.now();
      await page.waitForSelector('li.pIav2d', { timeout: 15_000 });
      console.log(`[navigate:detail] selector li.pIav2d found in ${Date.now() - selectorStart}ms`);
    } catch {
      console.log(`[navigate:detail] selector li.pIav2d not found after 15s, elapsed=${Date.now() - start}ms`);
      await context.close();
      return { airlineDirectPrice: null, airlineDirectCurrency: null, bookingUrl: null, allBookingOptions: [] };
    }

    // Click the specific flight result
    const flightItems = page.locator('li.pIav2d');
    const count = await flightItems.count();
    if (flightIndex >= count) {
      await context.close();
      return { airlineDirectPrice: null, airlineDirectCurrency: null, bookingUrl: null, allBookingOptions: [] };
    }

    await flightItems.nth(flightIndex).click();
    await page.waitForTimeout(4000);

    // Extract booking options from the detail view
    // Google Flights renders "Book with LOTAirline\n$662" (Airline appended to name)
    // or "Book with Mytrip\n$704" (no Airline tag for OTAs)
    const detailCurrency = params.currency || null;
    const result = await page.evaluate((curr) => {
      const text = document.body.innerText ?? '';
      const options: Array<{ provider: string; isAirline: boolean; price: number; currency: string }> = [];

      const bookingPattern = /Book with (.+?)(?:Airline)?\n[£€$¥]?\s?([\d,.]+)/g;
      let match;
      while ((match = bookingPattern.exec(text)) !== null) {
        const rawProvider = match[1]!.trim();
        // Check if the full match area contains "Airline" tag
        const fullMatch = match[0]!;
        const isAirline = /Airline/.test(fullMatch);
        const provider = rawProvider.replace(/Airline$/, '').trim();
        const price = parseInt(match[2]!.replace(/[,.]/g, ''), 10);
        if (!isNaN(price) && provider.length > 0) {
          options.push({ provider, isAirline, price, currency: curr || 'USD' });
        }
      }

      return options;
    }, detailCurrency);

    await context.close();

    // Find the airline-direct option (tagged as "Airline")
    const airlineOption = result.find((o) => o.isAirline);
    console.log(`[navigate:detail] done: ${result.length} booking options, elapsed=${Date.now() - start}ms`);

    return {
      airlineDirectPrice: airlineOption?.price ?? null,
      airlineDirectCurrency: airlineOption?.currency ?? null,
      bookingUrl: null, // booking URL requires following a redirect — use Google Flights link
      allBookingOptions: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate:detail] failed (elapsed=${Date.now() - start}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function navigateAirlineDirect(
  params: FlightSearchParams,
  airlineName: string,
  countryProfile?: CountryProfile,
  proxyUrl?: string
): Promise<NavigationResult> {
  const url = getAirlineUrl(airlineName, params);
  if (!url) {
    throw new Error(`No URL pattern for airline: ${airlineName}`);
  }

  const browser = await launchBrowser({ proxyUrl });
  const start = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();
    console.log(`[navigate:airline] → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    console.log(`[navigate:airline] goto resolved in ${Date.now() - gotoStart}ms`);

    // Airline sites are slower — wait for dynamic content to render
    await randomDelay(4000, 7000);
    await simulateHumanBehavior(page);

    // Dismiss cookie/consent dialogs common on airline sites
    try {
      for (const label of ['Accept all', 'Accept', 'I agree', 'Accept cookies', 'OK', 'Got it']) {
        const btn = page.locator(`button:has-text("${label}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await randomDelay(1500, 3000);
          break;
        }
      }
    } catch {
      // No consent dialog — continue
    }

    // Heuristic: check if any price-like content loaded (currency symbols or digits)
    let resultsFound = false;
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? '';
          return /\$\s?\d|€\s?\d|£\s?\d|USD|EUR|GBP|\d+\.\d{2}/.test(text);
        },
        { timeout: 15_000 }
      );
      resultsFound = true;
    } catch {
      // No price content detected — page may be blocked or empty
    }

    const html = await page.evaluate(() => document.body.innerText);
    console.log(`[navigate:airline] resultsFound=${resultsFound}, textLength=${html.length}, elapsed=${Date.now() - start}ms`);

    await context.close();
    return { html, url, resultsFound, source: 'airline_direct' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate:airline] failed (elapsed=${Date.now() - start}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}
