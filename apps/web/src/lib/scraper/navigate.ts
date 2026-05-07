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

// IATA codes are exactly 3 uppercase A-Z. Anything else means the upstream
// query parser wrote garbage (or a user-supplied code escaped sanitization)
// and would otherwise corrupt the URL via raw interpolation.
const IATA_CODE = /^[A-Z]{3}$/;

function assertValidIataCode(code: string, role: 'origin' | 'destination'): void {
  if (!IATA_CODE.test(code)) {
    throw new Error(`Invalid IATA ${role} code: ${JSON.stringify(code)}`);
  }
}

function isoDate(d: Date): string {
  // toISOString().split('T')[0] returns the UTC calendar day. Callers that
  // construct dates in non-UTC timezones can see a day shift here; that risk
  // predates this file and is tracked separately.
  return d.toISOString().split('T')[0]!;
}

function buildFlightsUrl(qPhrase: string, params: FlightSearchParams): string {
  const url = new URL('https://www.google.com/travel/flights');
  url.searchParams.set('q', qPhrase);
  url.searchParams.set('hl', 'en');
  if (params.currency) url.searchParams.set('curr', params.currency);
  if (params.country) url.searchParams.set('gl', params.country);
  return url.toString();
}

export function buildGoogleFlightsUrl(params: FlightSearchParams): string {
  // Verbose phrase form. For one-way searches we omit the trailing "to ${dateTo}"
  // because Google Flights' NLU misparses "on YYYY-MM-DD to YYYY-MM-DD" for
  // less popular airport codes (BDS, BRI) and falls back to the bare homepage.
  // See #65.
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const dateFrom = isoDate(params.dateFrom);
  const dateTo = isoDate(params.dateTo);
  const oneWay = params.tripType === 'one_way';
  const oneWayPrefix = oneWay ? 'one way ' : '';
  const datePart = oneWay ? `on ${dateFrom}` : `on ${dateFrom} to ${dateTo}`;

  return buildFlightsUrl(
    `${oneWayPrefix}flights from ${params.origin} to ${params.destination} ${datePart}`,
    params,
  );
}

/**
 * Build three structurally distinct Google Flights URL candidates. The verbose
 * `q=` text URL is what humans land on, but it depends on Google's NLU and is
 * unreliable for less popular airport codes. Each candidate is a text URL that
 * carries the requested dates AND an unambiguous trip-type token — we
 * deliberately avoid date-less or trip-less URLs (SEO landings, partial
 * phrases) because Google fills missing fields with defaults and Playwright
 * would still see [data-gs], silently writing snapshots tagged with the
 * user's travelDate but priced for the wrong departure.
 */
export function buildGoogleFlightsUrlCandidates(params: FlightSearchParams): string[] {
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const dateFrom = isoDate(params.dateFrom);
  const dateTo = isoDate(params.dateTo);
  const oneWay = params.tripType === 'one_way';
  const oneWayPrefix = oneWay ? 'one way ' : '';

  // Variant 1: verbose phrase, fixed for one-way (above).
  const verbose = buildGoogleFlightsUrl(params);

  // Variant 2: terse codes + date — fewer NLU tokens for Google to misinterpret.
  // Always include the one-way token so Google does not infer round trip.
  const terseDate = oneWay ? dateFrom : `${dateFrom} to ${dateTo}`;
  const terse = buildFlightsUrl(
    `${oneWayPrefix}${params.origin} to ${params.destination} ${terseDate}`,
    params,
  );

  // Variant 3: reworded phrase — different verbs ("departing"/"returning") and
  // a different word order put the airport codes adjacent to the keywords
  // Google's NLU is most confident about, while still carrying the date(s)
  // and an explicit one-way marker for one-way trips.
  const dateClause = oneWay
    ? `departing ${dateFrom}`
    : `departing ${dateFrom} returning ${dateTo}`;
  const reworded = buildFlightsUrl(
    `${oneWayPrefix}flights to ${params.destination} from ${params.origin} ${dateClause}`,
    params,
  );

  return [verbose, terse, reworded];
}

/** Stable label per candidate index, used in logs so failures are diagnosable. */
const CANDIDATE_NAMES = ['verbose', 'terse', 'reworded'] as const;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verify the loaded Google Flights page shows the requested route IN THE
 * REQUESTED DIRECTION via at least one strict pattern. Loose membership +
 * proximity checks were rejected by audit because:
 *
 * * Chained routes leak: "BDS Brindisi to LHR via JFK" matched
 *   `BDS ... to ... JFK` even though the requested route never appears.
 * * Plain "to" is not token-bounded: matches inside "stop", "Toronto",
 *   "destination", so any flight card with a stop satisfies the regex
 *   regardless of the actual airports.
 * * Plain dash characters appear in dates, durations, and price ranges,
 *   so a wide context window around any dash gives false positives.
 *
 * Strict patterns demand immediate adjacency between the airport codes and
 * a route connector. That is what Google actually renders on results
 * pages: the search-bar header, breadcrumbs, and route chips all show
 * `from BDS to JFK`, `BDS - John F. Kennedy`, or `BDS → JFK` with the
 * codes adjacent to the connector.
 *
 * Failure modes this function does NOT cover:
 *
 * * Wrong date with the right route. Google renders dates in too many
 *   formats to match reliably; mitigated by carrying the date in every
 *   URL candidate and by URL rotation.
 * * Wrong trip type. Mitigated by the explicit `one way` token in every
 *   one-way URL candidate.
 *
 * Both residual risks fail-soft (the next candidate retries) rather than
 * silently overwriting good snapshots.
 */
export function pageHasRequestedRoute(
  pageText: string,
  origin: string,
  destination: string,
): boolean {
  const o = escapeRegex(origin);
  const d = escapeRegex(destination);

  // Each pattern requires the airport codes adjacent to a connector with
  // no other airport code between them. "?" / "*" quantifiers are bounded
  // tightly to avoid the chained-route leak.
  // "noOtherIata" matches a single character that is NOT the start of a
  // 3-letter uppercase IATA code. Used to allow airport names ("Brindisi",
  // "John F. Kennedy") between codes while blocking other airport codes
  // (LHR, FCO) from being layovers in chained-route phrases.
  const noOtherIata = `(?:(?!\\b[A-Z]{3}\\b)[\\s\\S])`;
  const strict: RegExp[] = [
    // "from BDS to JFK" / "from BDS Brindisi to John F. Kennedy JFK".
    new RegExp(`\\bfrom\\s+${o}\\b${noOtherIata}{0,80}\\bto\\b${noOtherIata}{0,80}\\b${d}\\b`),
    // "BDS to JFK" / "BDS Brindisi to JFK" with no other IATA in between.
    new RegExp(`\\b${o}\\b${noOtherIata}{0,80}\\bto\\b${noOtherIata}{0,80}\\b${d}\\b`),
    // "BDS → JFK" / "BDS ⇒ JFK" — immediate adjacency.
    new RegExp(`\\b${o}\\s*[→⇒]\\s*${d}\\b`),
    // "BDS - JFK" / "BDS – JFK" / "BDS — JFK" / "BDS-JFK" — immediate adjacency.
    new RegExp(`\\b${o}\\s*[-–—]\\s*${d}\\b`),
  ];

  return strict.some((re) => re.test(pageText));
}

/**
 * Detect the specific failure mode reported in #65: Google strips the `q`
 * parameter and redirects to the bare /travel/flights homepage. The input
 * URL has a q param; the resolved URL does not.
 */
export function pageRedirectedToHomepage(inputUrl: string, finalUrl: string): boolean {
  try {
    const had = new URL(inputUrl).searchParams.has('q');
    const has = new URL(finalUrl).searchParams.has('q');
    return had && !has;
  } catch {
    return false;
  }
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
    const candidateName = CANDIDATE_NAMES[attempt - 1] ?? 'unknown';
    const browser = await launchBrowser({ proxyUrl });
    const attemptStart = Date.now();

    try {
      const context = await createStealthContext(browser, { countryProfile, proxyUrl });
      const page = await context.newPage();
      console.log(`[navigate] attempt ${attempt}/${maxAttempts} (${candidateName}) → ${url}`);

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
      const finalUrl = page.url();

      // Belt-and-suspenders defense against silent route corruption. Three
      // layers; any failure marks the attempt failed and rotates to the next
      // URL candidate. A false success here would write snapshots labeled
      // with the user's travelDate but priced for a different route.
      //
      // 1. Homepage redirect: Google strips q= and lands on the bare
      //    /travel/flights URL. This is the headline #65 failure mode.
      // 2. Route membership + direction: both IATA codes must appear in the
      //    visible text AND in the requested order separated by a route
      //    connector (catches swapped routes and unrelated suggestion lists).
      if (resultsFound && pageRedirectedToHomepage(url, finalUrl)) {
        console.log(`[navigate] q= dropped on redirect (input=${url}, final=${finalUrl}) — treating attempt ${attempt} (${candidateName}) as failed`);
        resultsFound = false;
      }
      if (resultsFound && !pageHasRequestedRoute(html, params.origin, params.destination)) {
        console.log(`[navigate] page text missing requested directional route (origin=${params.origin}, dest=${params.destination}, finalUrl=${finalUrl}) — treating attempt ${attempt} (${candidateName}) as failed`);
        resultsFound = false;
      }

      console.log(`[navigate] attempt ${attempt} (${candidateName}): resultsFound=${resultsFound}, textLength=${html.length}, finalUrl=${finalUrl}, elapsed=${Date.now() - attemptStart}ms`);

      await context.close();

      // Retry with fresh browser if no results and we have attempts left
      if (!resultsFound && attempt < maxAttempts) {
        console.log(`[navigate] no results on attempt ${attempt} (${candidateName}), retrying with next URL after delay…`);
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
        continue;
      }

      if (resultsFound) {
        console.log(`[navigate] succeeded with ${candidateName} candidate (final URL: ${finalUrl})`);
      }
      return { html, url, resultsFound, source: 'google_flights' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isCrash = /crashed|target closed|disposed/i.test(message);
      console.error(`[navigate] attempt ${attempt} (${candidateName}) failed (crash=${isCrash}, elapsed=${Date.now() - attemptStart}ms): ${message}`);

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
