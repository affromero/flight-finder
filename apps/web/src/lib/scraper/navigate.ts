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

export type NavigationSource = 'google_flights' | 'airline_direct' | 'skyscanner' | 'kayak';

export const AGGREGATOR_SOURCES = ['google_flights', 'airline_direct', 'skyscanner', 'kayak'] as const;

export function isAggregatorSource(value: unknown): value is NavigationSource {
  return typeof value === 'string' && (AGGREGATOR_SOURCES as readonly string[]).includes(value);
}

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

export function assertValidIataCode(code: string, role: 'origin' | 'destination'): void {
  if (!IATA_CODE.test(code)) {
    throw new Error(`Invalid IATA ${role} code: ${JSON.stringify(code)}`);
  }
}

export function isoDate(d: Date): string {
  // toISOString().split('T')[0] returns the UTC calendar day. Callers that
  // construct dates in non-UTC timezones can see a day shift here; that risk
  // predates this file and is tracked separately.
  return d.toISOString().split('T')[0]!;
}

// Issue 65: navigateAirlineDirect previously used a loose regex that accepted
// any single currency symbol plus digit. A Turkish stub page (1964 chars,
// "EUR" appearing in marketing copy) passed the gate, then extraction returned
// zero prices and the cron silently saved nothing every cycle. Two-criterion
// signal:
//   1. Currency must be mentioned at least MIN_CURRENCY_MENTIONS times. Real
//      airline result pages render many flight rows each with a price;
//      marketing stubs typically mention currency 0 to 2 times in chrome.
//   2. At least one price-shaped token (symbol or bounded code adjacent to a
//      digit). Lookaround prevents matching "TRY" inside INDUSTRY or "EUR"
//      inside EURO trip.
export const CURRENCY_MENTION_PATTERN = '€|£|\\$|EUR|GBP|USD|TRY|JPY|CHF';
export const PRICE_TOKEN_PATTERN = '(?:€|£|\\$)\\s?\\d|(?<![A-Za-z])(?:EUR|GBP|USD|TRY|JPY|CHF)(?![A-Za-z])\\s?\\d';
export const MIN_CURRENCY_MENTIONS = 3;

export function hasFlightPriceSignal(text: string): boolean {
  const mentions = (text.match(new RegExp(CURRENCY_MENTION_PATTERN, 'g')) || []).length;
  if (mentions < MIN_CURRENCY_MENTIONS) return false;
  return new RegExp(PRICE_TOKEN_PATTERN).test(text);
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
/**
 * Currencies allowed inside the route-validation gap. The first 21 entries
 * mirror the dropdown in apps/web/src/app/settings/page.tsx; TRY is added
 * because Flight Finder's #64 example was IST/AYT (Turkish market) and TRY
 * labels appear in those headers even though TRY is not in the settings
 * dropdown today.
 *
 * Accepted residual risk: several of these codes are also valid IATA
 * airport codes (HKD = Hakodate, BRL = Borba, CAD = Cadillac, CHF = Chefornak,
 * NOK = Nogales, DKK = Dakar military, ARS = Aragarcas, etc.). A chained
 * route like "BDS to HKD via JFK" therefore accepts under current policy.
 * Real Google Flights pages do not render that phrasing for a JFK booking,
 * so the practical corruption frequency is near zero, but the invariant is
 * not "currencies are never airport codes". Removing overlapping codes
 * would re-introduce false negatives for users in those currency locales,
 * which is the actual reported bug; on balance we keep them.
 *
 * Users selecting "Other..." in settings pass the custom code via the
 * `currency` arg to pageHasRequestedRoute, allowed dynamically.
 */
const ALLOWED_CURRENCY_TOKENS = [
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'MXN',
  'BRL', 'KRW', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'COP',
  'ARS', 'TRY',
] as const;

export function pageHasRequestedRoute(
  pageText: string,
  origin: string,
  destination: string,
  currency?: string | null,
): boolean {
  const o = escapeRegex(origin);
  const d = escapeRegex(destination);

  // Tokens the strict regex allows inside the gap between origin and destination:
  //
  // 1. Origin and destination themselves: Google headers render the code both
  //    as a label and a parenthetical alias ("BDS Brindisi (BDS) to JFK").
  // 2. The currency the query uses: passed dynamically so users who selected
  //    "Other..." in settings (any ISO 4217 3-letter code) are covered.
  // 3. The standard supported currency list (above): covers cases where the
  //    query has currency=null and Google auto-detects locale-appropriate.
  //
  // Two things block the gap:
  //
  // (a) Any 3-letter uppercase token NOT in the allowlist (LHR, FCO, NYC,
  //     USA) blocks. That stops "BDS Brindisi to LHR via JFK" from matching.
  // (b) The chaining keywords `via`, `layover`, `through`, `connecting`
  //     block. That closes the currency/IATA overlap edge case (HKD is
  //     also Hakodate airport): "BDS to HKD via JFK" still has `via` in
  //     the gap, so the lazy match cannot reach JFK regardless of whether
  //     HKD is treated as currency or airport. Real Google Flights route
  //     headers never use these words between the airport pair.
  const dynamicCurrency = currency && /^[A-Z]{3}$/.test(currency) ? [currency] : [];
  const allowedInGap = [origin, destination, ...dynamicCurrency, ...ALLOWED_CURRENCY_TOKENS]
    .map(escapeRegex)
    .join('|');
  // Chaining keywords matched case-insensitively. JS regex has no inline (?i)
  // flag and the top-level /i flag would break the [A-Z]{3} IATA guard in
  // the same alternation, so each ASCII letter is expanded to a character
  // class via `ci` below. The helper hard-fails on regex metacharacters so a
  // future addition to the phrase list cannot silently inject regex syntax.
  //
  // Phrase coverage: bare chain words (via / layover / through / connecting /
  // stopover) plus phrase-form variants that close the currency/IATA overlap
  // for `stop`-family chained routes ("stopping at", "stops in", "with a
  // stop at", "connection in"). Bare `stop`/`stops`/`stopping` is NOT
  // blocked because real flight-card metadata (`1 stop`, `Nonstop`) sits in
  // the 80-char gap on legitimate pages.
  const ci = (word: string): string => {
    if (!/^[a-z]+$/.test(word)) {
      throw new Error(`pageHasRequestedRoute: ci() expects lowercase ASCII letters only, got ${JSON.stringify(word)}`);
    }
    return word.split('').map((ch) => `[${ch}${ch.toUpperCase()}]`).join('');
  };
  const chainPhrases = [
    ci('via'),
    ci('layover'),
    ci('through'),
    ci('connecting'),
    ci('stopover'),
    // "stop over" / "stop-over"
    `${ci('stop')}[-\\s]+${ci('over')}`,
    // "stop at"/"stop in"/"stops at"/"stops in"
    `${ci('stop')}${ci('s')}?\\s+${ci('at')}`,
    `${ci('stop')}${ci('s')}?\\s+${ci('in')}`,
    // "stopping at"/"stopping in"
    `${ci('stopping')}\\s+(?:${ci('at')}|${ci('in')})`,
    // "with stop"/"with a stop"/"with stopover"/"with a stopover"
    `${ci('with')}\\s+(?:${ci('a')}\\s+)?${ci('stop')}(?:${ci('over')})?`,
    // "connection"/"connection at"/"connection in"/"connection through"
    `${ci('connection')}(?:\\s+(?:${ci('at')}|${ci('in')}|${ci('through')}))?`,
  ];
  const blockingChainKeyword = `\\b(?:${chainPhrases.join('|')})\\b`;
  const noOtherIata = `(?:(?!${blockingChainKeyword})(?!\\b(?!(?:${allowedInGap})\\b)[A-Z]{3}\\b)[\\s\\S])`;
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
      if (resultsFound && !pageHasRequestedRoute(html, params.origin, params.destination, params.currency)) {
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

    // Two-criterion price signal (see hasFlightPriceSignal at module top, issue 65).
    let resultsFound = false;
    try {
      await page.waitForFunction(
        (params: { mention: string; token: string; min: number }) => {
          const text = document.body?.innerText ?? '';
          const mentions = (text.match(new RegExp(params.mention, 'g')) || []).length;
          if (mentions < params.min) return false;
          return new RegExp(params.token).test(text);
        },
        { mention: CURRENCY_MENTION_PATTERN, token: PRICE_TOKEN_PATTERN, min: MIN_CURRENCY_MENTIONS },
        { timeout: 15_000 }
      );
      resultsFound = true;
    } catch {
      // No price signal detected — page may be a stub, marketing redirect, or block.
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

// Skyscanner uses lowercase 3-letter IATA codes in the path. The site accepts
// uppercase via redirect, but the canonical form is lowercase.
function isoDateShort(d: Date): string {
  const iso = isoDate(d); // YYYY-MM-DD
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10); // YYMMDD
}

// Skyscanner cabin slugs — mapping is the same set our app uses elsewhere.
const SKYSCANNER_CABIN: Record<string, string> = {
  economy: 'economy',
  premium_economy: 'premiumeconomy',
  business: 'business',
  first: 'first',
};

export function buildSkyscannerUrl(params: FlightSearchParams): string {
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const ori = params.origin.toLowerCase();
  const dst = params.destination.toLowerCase();
  const oneWay = params.tripType === 'one_way';
  const datePath = oneWay
    ? `${isoDateShort(params.dateFrom)}/`
    : `${isoDateShort(params.dateFrom)}/${isoDateShort(params.dateTo)}/`;

  const cabin = SKYSCANNER_CABIN[params.cabinClass ?? 'economy'] ?? 'economy';
  const qs = new URLSearchParams();
  qs.set('adultsv2', '1');
  qs.set('cabinclass', cabin);
  if (params.currency) qs.set('currency', params.currency);
  if (params.country) qs.set('market', params.country);

  return `https://www.skyscanner.com/transport/flights/${ori}/${dst}/${datePath}?${qs.toString()}`;
}

export function buildKayakUrl(params: FlightSearchParams): string {
  assertValidIataCode(params.origin, 'origin');
  assertValidIataCode(params.destination, 'destination');

  const ori = params.origin;
  const dst = params.destination;
  const oneWay = params.tripType === 'one_way';
  const datePath = oneWay
    ? isoDate(params.dateFrom)
    : `${isoDate(params.dateFrom)}/${isoDate(params.dateTo)}`;

  return `https://www.kayak.com/flights/${ori}-${dst}/${datePath}?sort=price_a`;
}

/**
 * Shared navigation helper for Skyscanner and Kayak. Both deploy aggressive
 * anti-bot (Cloudflare, PerimeterX) so reliability is best-effort, not
 * production grade. The 45s goto timeout matches navigateAirlineDirect because
 * Cloudflare interstitials regularly take 20-40s to clear.
 *
 * Caller passes a stable `source` label and a `tag` for log lines. Returns the
 * standard NavigationResult; resultsFound is gated by hasFlightPriceSignal so a
 * blocked or interstitial page returns resultsFound=false and the caller can
 * walk to the next aggregator in the chain.
 */
async function navigateAggregatorPage(
  url: string,
  source: NavigationSource,
  tag: string,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const browser = await launchBrowser({ proxyUrl });
  const start = Date.now();

  try {
    const context = await createStealthContext(browser, { countryProfile, proxyUrl });
    const page = await context.newPage();
    console.log(`[navigate:${tag}] → ${url}`);

    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    console.log(`[navigate:${tag}] goto resolved in ${Date.now() - gotoStart}ms`);

    // Heavier post-goto wait than airline_direct — Cloudflare interstitials on
    // Skyscanner and Kayak commonly delay real content by 4-8 seconds.
    await randomDelay(4000, 8000);
    await simulateHumanBehavior(page);

    try {
      for (const label of ['Accept all', 'I agree', 'OK, got it', 'Got it', 'Allow all', 'Accept cookies']) {
        const btn = page.locator(`button:has-text("${label}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await randomDelay(1500, 3000);
          break;
        }
      }
    } catch {
      // No consent dialog visible.
    }

    let resultsFound = false;
    try {
      await page.waitForFunction(
        (p: { mention: string; token: string; min: number }) => {
          const text = document.body?.innerText ?? '';
          const mentions = (text.match(new RegExp(p.mention, 'g')) || []).length;
          if (mentions < p.min) return false;
          return new RegExp(p.token).test(text);
        },
        { mention: CURRENCY_MENTION_PATTERN, token: PRICE_TOKEN_PATTERN, min: MIN_CURRENCY_MENTIONS },
        { timeout: 15_000 },
      );
      resultsFound = true;
    } catch {
      // No price signal — most likely Cloudflare challenge, PerimeterX, or empty results.
    }

    const html = await page.evaluate(() => document.body.innerText);
    console.log(`[navigate:${tag}] resultsFound=${resultsFound}, textLength=${html.length}, elapsed=${Date.now() - start}ms`);

    await context.close();
    return { html, url, resultsFound, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[navigate:${tag}] failed (elapsed=${Date.now() - start}ms): ${message}`);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function navigateSkyscanner(
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const url = buildSkyscannerUrl(params);
  return navigateAggregatorPage(url, 'skyscanner', 'skyscanner', countryProfile, proxyUrl);
}

export async function navigateKayak(
  params: FlightSearchParams,
  countryProfile?: CountryProfile,
  proxyUrl?: string,
): Promise<NavigationResult> {
  const url = buildKayakUrl(params);
  return navigateAggregatorPage(url, 'kayak', 'kayak', countryProfile, proxyUrl);
}
