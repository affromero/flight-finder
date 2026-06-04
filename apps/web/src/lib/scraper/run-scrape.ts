import { mkdir, writeFile } from 'fs/promises';
import { prisma } from '@/lib/prisma';
import {
  navigateGoogleFlights,
  navigateAirlineDirect,
  navigateSkyscanner,
  navigateKayak,
  type NavigationResult,
  type NavigationSource,
} from './navigate';
import { extractPrices, type ExtractionFailureReason } from './extract-prices';
import { getModelCosts } from './ai-registry';
import { isKnownAirline } from './airline-urls';
import { getCountryProfile } from './country-profiles';
import { createVpnProvider, type VpnProviderType } from './vpn';
import { expandQueryDates } from './scrape-dates';

const RETRYABLE_FAILURES: ExtractionFailureReason[] = [
  'empty_extraction',
  'page_not_loaded',
  'no_json_in_response',
  'llm_error',
  'json_parse_error',
];
// Diversifiable failures move on to the next aggregator in the chain. The
// existing issue-65 invariant: all_filtered_out is NOT diversifiable (real
// flights existed; user filters excluded them) and json_parse_error is
// retryable but not diversifiable (same LLM is likely to error on the next
// source too).
const DIVERSIFIABLE_FAILURES: ExtractionFailureReason[] = [
  'empty_extraction',
  'no_json_in_response',
  'page_not_loaded',
  'llm_error',
];
const MAX_EXTRACT_ATTEMPTS = 2;
const DEBUG_DIR = '/tmp/flight-finder-debug';
const VPN_INTER_COUNTRY_DELAY_MS = 12000;
const DEFAULT_AGGREGATORS_ENABLED: NavigationSource[] = ['google_flights', 'airline_direct'];

/**
 * Resolve the ordered aggregator fallback chain for a single query.
 *
 * Precedence: per-query override > per-user preference > admin allowlist
 * order. The chain always excludes 'airline_direct' (handled separately
 * before the chain walk) and is filtered against the admin allowlist so a
 * disabled aggregator is never invoked regardless of user preference. The
 * terminal element is always 'google_flights' when admin allows it, with a
 * final safety net forcing google_flights even if the admin misconfigured
 * everything away.
 */
export function resolveAggregatorChain(
  queryPrefs: readonly string[],
  userPrefs: readonly string[],
  adminEnabled: readonly string[],
): NavigationSource[] {
  const enabled = adminEnabled.length > 0 ? adminEnabled : DEFAULT_AGGREGATORS_ENABLED;
  const requested: readonly string[] =
    queryPrefs.length > 0 ? queryPrefs :
    userPrefs.length > 0 ? userPrefs :
    enabled;

  const chain = requested
    .filter((s): s is NavigationSource =>
      s === 'google_flights' || s === 'skyscanner' || s === 'kayak'
    )
    .filter((s) => enabled.includes(s));

  // Dedupe while preserving order
  const seen = new Set<NavigationSource>();
  const deduped: NavigationSource[] = [];
  for (const s of chain) {
    if (!seen.has(s)) {
      seen.add(s);
      deduped.push(s);
    }
  }

  if (!deduped.includes('google_flights') && enabled.includes('google_flights')) {
    deduped.push('google_flights');
  }
  if (deduped.length === 0) {
    deduped.push('google_flights');
  }
  return deduped;
}

async function saveDebugHtml(queryId: string, html: string, attempt: number): Promise<void> {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${DEBUG_DIR}/${queryId}-attempt${attempt}-${ts}.html`;
    await writeFile(path, html, 'utf-8');
    console.log(`[scrape] saved debug HTML → ${path} (${html.length} chars)`);
  } catch (err) {
    console.log(`[scrape] failed to save debug HTML: ${err instanceof Error ? err.message : err}`);
  }
}

interface ScrapeResult {
  queryId: string;
  status: 'success' | 'partial' | 'failed';
  snapshotsCount: number;
  extractionCost: number;
  error?: string;
}

interface PairScrapeResult {
  prices: import('./extract-prices').PriceData[];
  inputTokens: number;
  outputTokens: number;
  sources: Set<string>;
  lastFailureReason: string | undefined;
}

/**
 * Scrape a single (outbound, return) date pair, with extract retries.
 *
 * Flow per attempt:
 *   1. If `useAirlineDirect`, fan out across `directAirlines` in parallel. Any
 *      airline page that passes the price-signal gate yields a NavigationResult
 *      we extract from. Failures here surface a `lastFailureReason`.
 *   2. If step 1 produced no prices AND the failure reason is diversifiable
 *      (or step 1 was skipped entirely), walk the `aggregatorChain` in order
 *      (google_flights / skyscanner / kayak). Stop the walk as soon as prices
 *      land or `all_filtered_out` is seen (filters, not the source, are the
 *      cause — moving on cannot help).
 *   3. If still no prices and the failure is retryable, sleep + retry the
 *      whole attempt.
 *
 * Preserves the issue-65 invariant: an airline page that returns stub HTML
 * (passes hasFlightPriceSignal but extracts to 0 flights) falls through to
 * google_flights inside the same attempt rather than retrying the same broken
 * page.
 */
async function scrapeOneDatePair(
  queryId: string,
  pairParams: import('./navigate').FlightSearchParams,
  filters: import('./extract-prices').QueryFilters,
  directAirlines: string[],
  useAirlineDirect: boolean,
  aggregatorChain: NavigationSource[],
  countryProfile: ReturnType<typeof getCountryProfile> | undefined,
  proxyUrl: string | undefined,
  vpnCountry: string | null,
): Promise<PairScrapeResult> {
  const effectiveCurrency = pairParams.currency ?? null;
  const travelDateFallback = pairParams.dateFrom.toISOString().split('T')[0]!;

  const sources = new Set<string>();
  let prices: import('./extract-prices').PriceData[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFailureReason: string | undefined;

  async function extractFromNav(nav: NavigationResult, attempt: number): Promise<void> {
    sources.add(nav.source);
    const result = await extractPrices(
      nav.html, nav.url, travelDateFallback, filters, undefined, nav.resultsFound, nav.source, effectiveCurrency,
    );
    prices = prices.concat(result.prices);
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    if (result.failureReason) {
      lastFailureReason = result.failureReason;
      await saveDebugHtml(queryId, nav.html, attempt);
    } else {
      lastFailureReason = undefined;
    }
  }

  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
    const vpnLabel = vpnCountry ? ` vpn=${vpnCountry}` : '';
    console.log(`[scrape] query=${queryId}${vpnLabel} pair=${travelDateFallback} extract attempt ${attempt}/${MAX_EXTRACT_ATTEMPTS}`);

    // Step 1 — airline_direct fan-out (when applicable).
    let triedAirlineDirect = false;
    if (useAirlineDirect) {
      triedAirlineDirect = true;
      const results = await Promise.all(
        directAirlines.map(async (airline) => {
          try {
            const result = await navigateAirlineDirect(pairParams, airline, countryProfile, proxyUrl);
            return result.resultsFound ? result : null;
          } catch {
            return null;
          }
        })
      );
      const valid = results.filter((r): r is NavigationResult => r !== null);
      for (const nav of valid) {
        await extractFromNav(nav, attempt);
      }
    }

    // Step 2 — walk the aggregator chain when step 1 produced nothing AND the
    // failure is diversifiable (or step 1 was skipped). all_filtered_out
    // short-circuits the entire chain — same invariant as the pre-refactor
    // diversification block: real flights existed, filters excluded them, so
    // changing sources cannot help.
    const shouldWalkChain =
      prices.length === 0 &&
      (
        !triedAirlineDirect ||
        lastFailureReason === undefined ||
        DIVERSIFIABLE_FAILURES.includes(lastFailureReason as ExtractionFailureReason)
      );

    if (shouldWalkChain) {
      if (triedAirlineDirect) {
        console.log(`[scrape] query=${queryId} pair=${travelDateFallback} diversifying airline_direct -> chain=${aggregatorChain.join(',')} (reason: ${lastFailureReason ?? 'no-extraction'})`);
      }
      for (const source of aggregatorChain) {
        if (prices.length > 0) break;
        let nav: NavigationResult;
        try {
          switch (source) {
            case 'google_flights':
              nav = await navigateGoogleFlights(pairParams, countryProfile, proxyUrl);
              break;
            case 'skyscanner':
              nav = await navigateSkyscanner(pairParams, countryProfile, proxyUrl);
              break;
            case 'kayak':
              nav = await navigateKayak(pairParams, countryProfile, proxyUrl);
              break;
            default:
              continue;
          }
        } catch (err) {
          console.error(`[scrape] query=${queryId} pair=${travelDateFallback} aggregator=${source} threw err=${err instanceof Error ? err.message : err}`);
          continue;
        }
        await extractFromNav(nav, attempt);
        // all_filtered_out short-circuits — real flights existed, filters excluded them
        if (lastFailureReason === 'all_filtered_out') break;
      }
    }

    if (prices.length > 0) break;

    if (attempt < MAX_EXTRACT_ATTEMPTS && lastFailureReason && RETRYABLE_FAILURES.includes(lastFailureReason as ExtractionFailureReason)) {
      const delay = 5000 + Math.random() * 5000;
      console.log(`[scrape] query=${queryId} pair=${travelDateFallback} retrying after ${Math.round(delay)}ms (reason: ${lastFailureReason})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { prices, inputTokens, outputTokens, sources, lastFailureReason };
}

/** Scrape a single query for a single country pass (local or VPN). */
async function scrapeQueryForCountry(
  queryId: string,
  query: {
    origin: string;
    destination: string;
    preferredAirlines: string[];
    preferredAggregators: string[];
    maxPrice: number | null;
    maxStops: number | null;
    maxDurationHours: number | null;
    timePreference: string;
    cabinClass: string;
    flexibility: number;
    user: { preferredAggregators: string[] } | null;
  },
  searchParams: import('./navigate').FlightSearchParams,
  config: { provider?: string; model?: string; aggregatorsEnabled?: string[] } | null,
  vpnCountry: string | null,
  proxyUrl: string | undefined,
  fetchRunId: string,
): Promise<ScrapeResult> {
  const countryProfile = vpnCountry ? getCountryProfile(vpnCountry) : undefined;

  const directAirlines = query.preferredAirlines.filter(isKnownAirline);
  const useAirlineDirect = directAirlines.length > 0;

  const adminEnabled = config?.aggregatorsEnabled ?? DEFAULT_AGGREGATORS_ENABLED;
  const aggregatorChain = resolveAggregatorChain(
    query.preferredAggregators ?? [],
    query.user?.preferredAggregators ?? [],
    adminEnabled,
  );
  console.log(`[scrape] query=${queryId} aggregator chain=${aggregatorChain.join(',')} (admin enabled=${adminEnabled.join(',')})`);

  const filters = {
    maxPrice: query.maxPrice,
    maxStops: query.maxStops,
    maxDurationHours: query.maxDurationHours,
    preferredAirlines: query.preferredAirlines,
    timePreference: query.timePreference,
    cabinClass: query.cabinClass,
  };
  const provider = config?.provider ?? 'anthropic';
  const model = config?.model ?? 'claude-haiku-4-5-20251001';
  const costs = getModelCosts(provider, model);

  // Expand the date window into per-pair scrapes. One-way iterates every day
  // in [dateFrom, dateTo] capped at 7. Round-trip emits a single (dateFrom,
  // dateTo) pair regardless of flexibility; iterating multiple pairs would
  // collapse same-outbound flights with different returns at the
  // flightId/dedupe layer.
  const pairs = expandQueryDates(
    {
      dateFrom: searchParams.dateFrom,
      dateTo: searchParams.dateTo,
      flexibility: query.flexibility ?? 0,
      tripType: searchParams.tripType ?? 'round_trip',
    },
    { oneWayCap: 7 },
  );
  console.log(`[scrape] query=${queryId} expanded into ${pairs.length} date pair(s)`);

  let allPrices: import('./extract-prices').PriceData[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastFailureReason: string | undefined;
  const sources = new Set<string>();
  const scrapedTravelDates = new Set<string>();

  for (const pair of pairs) {
    const pairTravelDate = pair.outbound.toISOString().slice(0, 10);
    const pairParams: import('./navigate').FlightSearchParams = {
      ...searchParams,
      dateFrom: pair.outbound,
      dateTo: pair.return_,
    };

    // Per-pair try/catch isolates failures: a thrown pair (browser crash,
    // VPN hiccup) must not discard prices already gathered from prior pairs.
    let pairResult: PairScrapeResult;
    try {
      pairResult = await scrapeOneDatePair(
        queryId, pairParams, filters, directAirlines, useAirlineDirect, aggregatorChain, countryProfile, proxyUrl, vpnCountry,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scrape] query=${queryId} pair=${pairTravelDate} threw err=${msg}`);
      lastFailureReason = lastFailureReason ?? 'page_not_loaded';
      continue;
    }

    allPrices = allPrices.concat(pairResult.prices);
    totalInputTokens += pairResult.inputTokens;
    totalOutputTokens += pairResult.outputTokens;
    for (const s of pairResult.sources) sources.add(s);
    if (pairResult.lastFailureReason) {
      lastFailureReason = pairResult.lastFailureReason;
    }
    // Only mark this travelDate as authoritatively scraped if the pair
    // produced prices. Without this gate, a pair that hit page_not_loaded
    // or llm_error would still flag prior snapshots for that date as
    // sold_out, even though we did not actually verify availability.
    if (pairResult.prices.length > 0) {
      scrapedTravelDates.add(pairTravelDate);
    }
  }

  // Deduplicate by airline + price + date + vpnCountry
  const seen = new Set<string>();
  allPrices = allPrices.filter((p) => {
    const key = `${p.airline}:${p.price}:${p.travelDate}:${vpnCountry ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  allPrices.sort((a, b) => a.price - b.price);

  const extractionCost =
    (totalInputTokens / 1000) * costs.costPer1kInput +
    (totalOutputTokens / 1000) * costs.costPer1kOutput;

  await prisma.apiUsageLog.create({
    data: {
      provider,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: extractionCost,
      operation: 'extract-prices',
      durationMs: 0,
    },
  });

  // Build stable flightId for each price. When the LLM extracted a real flight
  // number, prefer that over the departure time so codeshares at the same
  // minute do not collide. flightIdLegacy carries the time-only form for
  // matching against rows persisted before this rollout (kept in memory only,
  // never written to the DB).
  const withFlightIds = allPrices.map((p) => {
    const timePart = (p.departureTime ?? '').replace(/[^0-9]/g, '') || '0000';
    const airlinePart = p.airline.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
    const flightNumberPart = (p.flightNumber ?? '').replace(/\s+/g, '').toUpperCase();
    const idTail = flightNumberPart || timePart;
    const flightId = `${airlinePart}-${idTail}-${query.origin}-${query.destination}-${p.travelDate}`;
    const flightIdLegacy = `${airlinePart}-${timePart}-${query.origin}-${query.destination}-${p.travelDate}`;
    return { ...p, flightId, flightIdLegacy };
  });

  // Sold-out detection: scope by BOTH queryId AND vpnCountry to avoid cross-country false positives
  const previousSnapshots = await prisma.priceSnapshot.findMany({
    where: {
      queryId,
      vpnCountry: vpnCountry ?? null,
      flightId: { not: null },
    },
    orderBy: { scrapedAt: 'desc' },
    distinct: ['flightId'],
    select: { flightId: true, price: true, airline: true, travelDate: true, currency: true, bookingUrl: true, stops: true, duration: true, departureTime: true, arrivalTime: true, flightNumber: true, status: true },
  });

  // Match prior rows against BOTH the new and the legacy id forms so the
  // rollout does not flag every existing flight as sold out when scraping
  // resumes.
  //
  // Scope sold-out detection to dates we actually scraped this run. With
  // multi-pair scraping (issue #65 fix), the date pairs sampled per cron run
  // can change, and snapshots for dates outside the current pair set must
  // not be flagged sold-out just because we did not look at them.
  const currentFlightIds = new Set(withFlightIds.map((p) => p.flightId));
  const currentLegacyIds = new Set(withFlightIds.map((p) => p.flightIdLegacy));
  const soldOutSnapshots = previousSnapshots
    .filter((prev) => {
      if (!prev.flightId || prev.status !== 'available') return false;
      const prevTravelIso = prev.travelDate.toISOString().slice(0, 10);
      if (!scrapedTravelDates.has(prevTravelIso)) return false;
      return !currentFlightIds.has(prev.flightId) && !currentLegacyIds.has(prev.flightId);
    })
    .map((prev) => ({
      queryId,
      travelDate: prev.travelDate,
      price: prev.price,
      currency: prev.currency,
      airline: prev.airline,
      bookingUrl: prev.bookingUrl,
      stops: prev.stops,
      duration: prev.duration,
      departureTime: prev.departureTime,
      arrivalTime: prev.arrivalTime,
      flightId: prev.flightId,
      flightNumber: prev.flightNumber,
      status: 'sold_out' as const,
      vpnCountry,
      fetchRunId,
    }));

  if (withFlightIds.length > 0) {
    await prisma.priceSnapshot.createMany({
      // Drop flightIdLegacy before insert; it is only used for in-memory
      // sold-out matching above.
      data: withFlightIds.map(({ flightIdLegacy: _legacy, ...p }) => ({
        queryId,
        travelDate: new Date(p.travelDate),
        price: p.price,
        currency: p.currency,
        airline: p.airline,
        bookingUrl: p.bookingUrl,
        stops: p.stops,
        duration: p.duration,
        departureTime: p.departureTime ?? null,
        arrivalTime: p.arrivalTime ?? null,
        flightId: p.flightId,
        flightNumber: p.flightNumber ?? null,
        seatsLeft: p.seatsLeft ?? null,
        vpnCountry,
        fetchRunId,
      })),
    });
  }

  if (soldOutSnapshots.length > 0) {
    await prisma.priceSnapshot.createMany({
      data: soldOutSnapshots,
    });
  }

  console.log(`[scrape] query=${queryId} vpn=${vpnCountry ?? 'local'} finished — ${allPrices.length} prices, cost=$${extractionCost.toFixed(4)}`);
  const failureReason = allPrices.length === 0 ? lastFailureReason : undefined;
  const failureMessages: Record<string, string> = {
    page_not_loaded: 'Page did not load results — blocked, CAPTCHA, or timeout.',
    no_json_in_response: 'LLM response contained no parseable JSON array. Page HTML may be a consent wall, error page, or empty shell.',
    empty_extraction: 'LLM parsed the page but returned 0 flights. Page likely loaded without flight content (rate-limited or empty response).',
    all_filtered_out: 'Flights were extracted but all removed by query filters (price/stops/airline).',
    llm_error: 'LLM call failed (timeout, rate limit, or provider error). The provider may be temporarily unavailable.',
    json_parse_error: 'LLM returned invalid JSON. Provider output was malformed or truncated.',
  };
  const errorMsg = failureReason ? failureMessages[failureReason] : undefined;

  const sourceLabel = sources.size === 1 ? [...sources][0]! : [...sources].join('+');

  await prisma.fetchRun.update({
    where: { id: fetchRunId },
    data: {
      status: allPrices.length > 0 ? 'success' : 'failed',
      source: sourceLabel,
      snapshotsCount: allPrices.length,
      extractionCost,
      error: errorMsg,
      completedAt: new Date(),
    },
  });

  return {
    queryId,
    status: allPrices.length > 0 ? 'success' : 'failed',
    snapshotsCount: allPrices.length,
    extractionCost,
    error: errorMsg,
  };
}

/** Scrape a single query (no VPN logic -- called by runScrapeAll which handles country grouping). */
export async function runScrapeForQuery(
  queryId: string,
  vpnCountry?: string | null,
  proxyUrl?: string,
  opts?: { fetchRunId?: string },
): Promise<ScrapeResult> {
  const query = await prisma.query.findUnique({
    where: { id: queryId },
    include: { user: { select: { preferredAggregators: true } } },
  });
  if (!query || !query.active) {
    const errorMsg = 'Query not found or inactive';
    // If the caller pre-created an in_progress row, finalize it here so
    // the manual scrape endpoint's lock doesn't see a stuck row forever
    // and refuse all future refreshes.
    if (opts?.fetchRunId) {
      await prisma.fetchRun.update({
        where: { id: opts.fetchRunId },
        data: { status: 'failed', error: errorMsg, completedAt: new Date() },
      }).catch(() => {});
    }
    return { queryId, status: 'failed', snapshotsCount: 0, extractionCost: 0, error: errorMsg };
  }

  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const effectiveCurrency = query.currency ?? config?.defaultCurrency ?? null;
  const effectiveCountry = vpnCountry ?? config?.defaultCountry ?? null;

  const searchParams = query.isSeed
    ? {
        origin: query.origin,
        destination: query.destination,
        dateFrom: new Date(),
        dateTo: new Date(Date.now() + query.lookAheadDays * 24 * 60 * 60 * 1000),
        cabinClass: query.cabinClass,
        tripType: query.tripType,
        currency: effectiveCurrency,
        country: effectiveCountry,
      }
    : { ...query, cabinClass: query.cabinClass, tripType: query.tripType, currency: effectiveCurrency, country: effectiveCountry };

  // Reuse a pre-created row when the caller (e.g. the manual /scrape endpoint)
  // already wrote an `in_progress` row so the UI dot lights up before the
  // network IO starts. Falls back to creating a fresh row for the cron path.
  const fetchRun = opts?.fetchRunId
    ? { id: opts.fetchRunId }
    : await prisma.fetchRun.create({
        data: { queryId, status: 'in_progress', vpnCountry: vpnCountry ?? null },
      });

  try {
    return await scrapeQueryForCountry(
      queryId, query, searchParams, config, vpnCountry ?? null, proxyUrl, fetchRun.id
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Log before updating the DB row so cron operators can diagnose silent
    // failures from logs alone (issue #65). Without this, the only signal
    // was the cron summary line "0 ok, N failed".
    console.error(`[scrape] runScrapeForQuery failed query=${queryId} err=${errorMsg}`);
    await prisma.fetchRun.update({
      where: { id: fetchRun.id },
      data: { status: 'failed', error: errorMsg, completedAt: new Date() },
    });
    return { queryId, status: 'failed', snapshotsCount: 0, extractionCost: 0, error: errorMsg };
  }
}

/**
 * Scrape a single query across all its VPN countries (local + VPN passes).
 *
 * When `opts.fetchRunId` is provided, the FIRST country pass (always the
 * local null pass) reuses that pre-created row. Subsequent VPN passes
 * each create their own row at the TOP of the loop iteration (before the
 * VPN connect/disconnect), so the manual scrape endpoint's "any sibling
 * has an in_progress row" lock stays held continuously across passes
 * instead of opening a 30+ second window during the next country's VPN
 * connect. Each row is then passed back into runScrapeForQuery via
 * fetchRunId so the row gets finalised by the same code path that the
 * cron uses (no double-creation).
 */
export async function runFullScrapeForQuery(
  queryId: string,
  opts?: { fetchRunId?: string },
): Promise<ScrapeResult[]> {
  const query = await prisma.query.findUnique({ where: { id: queryId } });
  if (!query) return [];

  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const vpnProviderType = (config?.vpnProvider as VpnProviderType) ?? 'none';
  const vpnProvider = createVpnProvider(vpnProviderType);
  const defaultVpnCountries = config?.vpnCountries ?? [];
  const proxyUrl = vpnProvider.getProxyUrl?.() ?? undefined;

  const countries = query.vpnCountries.length > 0 ? query.vpnCountries : defaultVpnCountries;
  const countriesToScrape: (string | null)[] = countries.length > 0
    ? [null, ...countries]
    : [null];

  const results: ScrapeResult[] = [];

  for (let ci = 0; ci < countriesToScrape.length; ci++) {
    const country = countriesToScrape[ci]!;
    const isVpnPass = country !== null;

    // Create (or reuse) this pass's FetchRun BEFORE any VPN
    // connect/disconnect. The previous iteration's row has just been
    // finalised by runScrapeForQuery; without this pre-creation the
    // manual scrape endpoint could see "no in_progress rows" during the
    // 30+ second VPN connect window and accept a second concurrent run.
    let passFetchRunId: string;
    if (ci === 0 && opts?.fetchRunId) {
      passFetchRunId = opts.fetchRunId;
    } else {
      const row = await prisma.fetchRun.create({
        data: { queryId, status: 'in_progress', vpnCountry: country },
        select: { id: true },
      });
      passFetchRunId = row.id;
    }

    if (isVpnPass) {
      const connected = await vpnProvider.connect(country);
      if (!connected) {
        console.error(`[scrape] failed to connect VPN to ${country}, skipping`);
        // Don't leave the just-pre-created row stuck at in_progress.
        await prisma.fetchRun.update({
          where: { id: passFetchRunId },
          data: { status: 'failed', error: `VPN connect to ${country} failed`, completedAt: new Date() },
        }).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 3000));
    } else if (ci > 0) {
      await vpnProvider.disconnect();
    }

    const result = await runScrapeForQuery(queryId, country, isVpnPass ? proxyUrl : undefined, { fetchRunId: passFetchRunId });
    results.push(result);

    if (isVpnPass && ci < countriesToScrape.length - 1) {
      await new Promise((r) => setTimeout(r, VPN_INTER_COUNTRY_DELAY_MS + Math.random() * 3000));
    }
  }

  if (countries.length > 0) {
    await vpnProvider.disconnect();
  }

  return results;
}

export async function cleanupUnvisitedQueries(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.query.deleteMany({
    where: { firstViewedAt: null, createdAt: { lt: cutoff }, isSeed: false },
  });
  return result.count;
}

async function trySyncToHub(): Promise<void> {
  try {
    const { syncToHub } = await import('../community-sync');
    await syncToHub();
  } catch (err) {
    console.error('[community] Sync error:', err instanceof Error ? err.message : err);
  }
}

let scrapeInProgress = false;

export async function runScrapeAll(): Promise<ScrapeResult[]> {
  if (scrapeInProgress) {
    throw new Error('Scrape already in progress');
  }
  scrapeInProgress = true;
  try {
    return await runScrapeAllInner();
  } finally {
    scrapeInProgress = false;
  }
}

async function runScrapeAllInner(): Promise<ScrapeResult[]> {
  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  // Respect the GUI pause toggle (ExtractionConfig.enabled). When paused, skip
  // the entire run so no background scraping or API cost happens.
  if (config?.enabled === false) {
    console.log('[scrape-all] paused via config.enabled=false — skipping run');
    return [];
  }
  const globalInterval = config?.scrapeInterval ?? 3;

  // Create VPN provider from config
  const vpnProviderType = (config?.vpnProvider as VpnProviderType) ?? 'none';
  const vpnProvider = createVpnProvider(vpnProviderType);
  const defaultVpnCountries = config?.vpnCountries ?? [];
  const proxyUrl = vpnProvider.getProxyUrl?.() ?? undefined;

  const activeQueries = await prisma.query.findMany({
    where: {
      active: true,
      OR: [
        { isSeed: true },
        { expiresAt: { gt: new Date() } },
      ],
    },
    include: {
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true },
      },
    },
  });

  const now = Date.now();
  const dueQueries = activeQueries.filter((q) => {
    const lastRun = q.fetchRuns[0];
    if (!lastRun) return true;
    const hoursSince = (now - lastRun.startedAt.getTime()) / (1000 * 60 * 60);
    return hoursSince >= (q.scrapeInterval ?? globalInterval);
  });

  const results: ScrapeResult[] = [];

  // Collect union of all VPN countries across all due queries
  // Per-query vpnCountries override the global default
  const allVpnCountries = new Set<string>();
  const queryCountryMap = new Map<string, string[]>();
  for (const q of dueQueries) {
    const countries = q.vpnCountries.length > 0 ? q.vpnCountries : defaultVpnCountries;
    queryCountryMap.set(q.id, countries);
    for (const c of countries) allVpnCountries.add(c);
  }

  // Group by country to minimize VPN reconnects:
  // all queries[local] -> switch to DE -> queries that need DE -> switch to JP -> queries that need JP
  const countriesToScrape: (string | null)[] = allVpnCountries.size > 0
    ? [null, ...Array.from(allVpnCountries)]
    : [null];

  const vpnLabel = allVpnCountries.size > 0 ? ` (VPN: ${Array.from(allVpnCountries).join(',')})` : '';
  console.log(`[scrape-all] ${dueQueries.length}/${activeQueries.length} queries due for scraping${vpnLabel}`);

  for (let ci = 0; ci < countriesToScrape.length; ci++) {
    const country = countriesToScrape[ci]!;
    const isVpnPass = country !== null;

    // Switch VPN for this country pass
    if (isVpnPass) {
      console.log(`[scrape-all] switching VPN to ${country}...`);
      const connected = await vpnProvider.connect(country);
      if (!connected) {
        console.error(`[scrape-all] failed to connect VPN to ${country}, skipping all queries for this country`);
        continue;
      }
      await new Promise((r) => setTimeout(r, 3000));
    } else if (ci > 0) {
      await vpnProvider.disconnect();
    }

    // Scrape queries that need this country
    const queriesForCountry = isVpnPass
      ? dueQueries.filter((q) => (queryCountryMap.get(q.id) ?? []).includes(country))
      : dueQueries; // local pass: all queries

    for (let qi = 0; qi < queriesForCountry.length; qi++) {
      const query = queriesForCountry[qi]!;
      const result = await runScrapeForQuery(
        query.id,
        country,
        isVpnPass ? proxyUrl : undefined,
      );
      results.push(result);

      if (qi < queriesForCountry.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000 + Math.random() * 5000));
      }
    }

    if (isVpnPass && ci < countriesToScrape.length - 1) {
      await new Promise((r) => setTimeout(r, VPN_INTER_COUNTRY_DELAY_MS + Math.random() * 3000));
    }
  }

  // Disconnect VPN after all passes
  if (allVpnCountries.size > 0) {
    await vpnProvider.disconnect();
  }

  await trySyncToHub();

  return results;
}
