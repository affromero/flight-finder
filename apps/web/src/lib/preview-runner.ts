/**
 * Core preview run pipeline: validation, single-route scraping, and the
 * worker pool that orchestrates parallel scrapes across (origin x
 * destination x date) tasks. Lives in lib/ rather than the route file
 * because Next.js disallows non-handler exports from app/api routes, and
 * tests need to import runPreview directly.
 */
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { cached, redis } from '@/lib/redis';
import {
  PREVIEW_ACTIVE_TIMEOUT_MS,
  type PreviewRequestPayload,
  type PreviewResultPayload,
  type RouteResultPayload,
} from '@/lib/preview-run';
import { isValidPriceAmount } from '@/lib/limits';
import { getModelCosts, resolveApiKey } from '@/lib/scraper/ai-registry';
import { isKnownAirline } from '@/lib/scraper/airline-urls';
import { extractPrices, type ExtractionFailureReason, type PriceData } from '@/lib/scraper/extract-prices';
import { navigateAirlineDirect, navigateGoogleFlights } from '@/lib/scraper/navigate';
import type { Airport } from '@/lib/scraper/parse-query';
import { expandContinuousRangeToDates } from '@/lib/scraper/scrape-dates';

const PREVIEW_MAX_DATES = 7;
const RETRYABLE_FAILURES: ExtractionFailureReason[] = [
  'empty_extraction',
  'page_not_loaded',
  'no_json_in_response',
  'llm_error',
  'json_parse_error',
];
const MAX_ATTEMPTS = 2;
const DEBUG_DIR = '/tmp/flight-finder-debug';
const PREVIEW_MAX_RESULTS = 20;

/**
 * Default max concurrent scrapeRoute calls. Each scrapeRoute launches a
 * fresh chromium via Playwright (roughly 150 MB), so on a small VPS the
 * memory ceiling is the binding constraint. Override via env when host
 * resources differ from the 3 concurrent ceiling that fits a 2 GB box.
 * Clamped to [1, 10].
 */
export function parsePreviewConcurrency(raw: string | undefined = process.env.PREVIEW_CONCURRENCY): number {
  if (raw === undefined) return 3;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.min(parsed, 10);
}

export const PREVIEW_CONCURRENCY = parsePreviewConcurrency();

/**
 * Redis key prefix for the per IP concurrent preview admission counter.
 * The counter is an integer incremented on admission and decremented when
 * the background run reaches a terminal state. It carries a TTL equal to
 * PREVIEW_ACTIVE_TIMEOUT_MS so a crashed worker that never releases cannot
 * permanently wedge a client's quota: the slot self heals once the run can
 * no longer be in flight.
 */
const PREVIEW_ADMISSION_KEY_PREFIX = 'preview-admit:';
const PREVIEW_ADMISSION_TTL_SECONDS = Math.ceil(PREVIEW_ACTIVE_TIMEOUT_MS / 1000);

/**
 * Outcome of acquirePreviewAdmission.
 *
 * - admitted: Redis atomically reserved a slot under the cap. The caller
 *   owns exactly one releasePreviewAdmission call once the run settles.
 * - rejected: the slot was not reserved and none is owed. This covers both
 *   "already at the cap" and "Redis is unavailable or errored." The gate
 *   fails CLOSED on any Redis problem (audit finding F): there is no DB
 *   count fallback, because that read then create path is non atomic and
 *   reopens the TOCTOU race the Redis counter exists to close. The caller
 *   returns 429 for either case.
 */
export type PreviewAdmission = 'admitted' | 'rejected';

function previewAdmissionKey(clientIp: string): string {
  return `${PREVIEW_ADMISSION_KEY_PREFIX}${clientIp}`;
}

/**
 * Atomic admission script. Runs INCR, the cap check, the conditional EXPIRE,
 * and the overshoot rollback DECR in a single server side step so there is no
 * window where INCR succeeds but a follow up command fails and leaks a slot
 * (audit finding F). Redis evaluates a script atomically, so a concurrent
 * burst is serialized: at most `cap` invocations see a post increment value at
 * or below the cap, and every overshoot rolls its own increment back, leaving
 * the counter exact.
 *
 * Returns 1 when the slot was reserved (the caller owns one release), 0 when
 * the client is already at the cap.
 */
const PREVIEW_ADMISSION_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

/**
 * Atomically reserve a concurrent preview slot for clientIp. Closes the
 * TOCTOU race in the old count then create gate (audit M5) and the partial
 * failure slot leak in the old INCR/EXPIRE/DECR sequence (audit finding F) by
 * running the whole admission decision as one Lua script.
 *
 * Fails CLOSED: if Redis is not configured or the script errors, the request
 * is rejected rather than admitted via a non atomic DB count. A preview is a
 * background scrape, so denying admission during a Redis outage is the safe
 * default; it cannot leak unbounded concurrent scrapes.
 */
export async function acquirePreviewAdmission(
  clientIp: string,
  cap: number,
): Promise<PreviewAdmission> {
  if (!redis) return 'rejected';
  const key = previewAdmissionKey(clientIp);
  try {
    const reserved = await redis.eval(
      PREVIEW_ADMISSION_SCRIPT,
      1,
      key,
      String(cap),
      String(PREVIEW_ADMISSION_TTL_SECONDS),
    );
    return reserved === 1 ? 'admitted' : 'rejected';
  } catch {
    // Fail closed: do not fall back to a non atomic DB count.
    return 'rejected';
  }
}

/**
 * Release a slot previously reserved by acquirePreviewAdmission. Floors at
 * zero so a double release or a release after the TTL reset key cannot drive
 * the counter negative and hand a client extra capacity.
 */
export async function releasePreviewAdmission(clientIp: string): Promise<void> {
  if (!redis) return;
  const key = previewAdmissionKey(clientIp);
  try {
    const remaining = await redis.decr(key);
    if (remaining < 0) {
      await redis.set(key, '0');
    }
  } catch {
    // Counter will TTL out on its own; nothing actionable here.
  }
}

export type RouteResult = RouteResultPayload;

/**
 * Resolved extraction context shared across all routes in a single
 * runPreview call. Hoisted out of scrapeRoute and out of extractPrices
 * (both used to re-read from the DB per attempt) so a 20 route preview
 * reads the config once instead of dozens of times. Parallel workers
 * share this same object. Issue 65 audit finding A4: customBaseUrl
 * added so extractPrices can avoid its own DB read.
 */
export interface ExtractionContext {
  provider: string;
  model: string;
  customBaseUrl: string | null;
  extractTimeoutSeconds: number | null;
  /** Pre-resolved API key (DB-stored key decrypted, else env), resolved once
   *  per preview so workers don't decrypt on every attempt (#149). */
  apiKey: string;
  costs: { costPer1kInput: number; costPer1kOutput: number };
}

interface ScrapeRouteParams {
  origin: string;
  destination: string;
  dateFrom: Date;
  dateTo: Date;
  dateFromStr: string;
  cabinClass: string;
  tripType: string;
  maxPrice: number | null;
  maxStops: number | null;
  maxDurationHours: number | null;
  preferredAirlines: string[];
  timePreference: string;
  currency: string | null;
  context: ExtractionContext;
  /** Unique task slot. Threaded into the debug HTML filename so two
   *  workers scraping the same (origin, destination) on different dates
   *  in the same millisecond cannot collide. */
  taskIndex: number;
}

interface PreviewValidationResult {
  origins: Airport[];
  destinations: Airport[];
  isOneWay: boolean;
}

export interface RunPreviewOptions {
  /**
   * Invoked after each task settles, regardless of success or failure.
   * runPreviewInBackground uses this to bump updatedAt on the PreviewRun
   * row so the backend stale marker does not falsely fail a healthy long
   * running scrape. Errors thrown from the callback are swallowed; they
   * must not abort the worker pool.
   */
  onTaskComplete?: () => void | Promise<void>;
  /**
   * Max concurrent scrapeRoute calls. Defaults to PREVIEW_CONCURRENCY.
   * Tests override to 1 to assert serial behavior, or to N to verify the
   * gate caps in flight work at N.
   */
  concurrency?: number;
}

export function buildCacheKey(
  origin: string,
  destination: string,
  dateFrom: string,
  dateTo: string,
  cabinClass: string,
  tripType: string,
  currency: string | null
): string {
  const hash = createHash('sha256')
    .update(`${origin}:${destination}:${dateFrom}:${dateTo}:${cabinClass}:${tripType}:${currency ?? 'auto'}`)
    .digest('hex')
    .slice(0, 16);
  return `preview:${hash}`;
}

export function validatePreviewPayload(
  payload: PreviewRequestPayload,
  maxCombos = 24,
): PreviewValidationResult {
  const { dateFrom, dateTo, outboundDates, returnDates, origins, destinations, tripType } = payload;

  if (origins.length === 0 || destinations.length === 0 || !dateFrom || !dateTo) {
    throw new Error('Missing required fields: origins, destinations, dateFrom, dateTo');
  }

  for (const airport of [...origins, ...destinations]) {
    if (!/^[A-Z]{3}$/.test(airport.code)) {
      throw new Error(`Invalid airport code "${airport.code}" - must be 3 uppercase letters`);
    }
  }

  const from = new Date(dateFrom + 'T00:00:00Z');
  const to = new Date(dateTo + 'T00:00:00Z');
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new Error('Invalid date format');
  }

  const isOneWay = tripType === 'one_way';
  if (!isOneWay && from >= to) {
    throw new Error('dateFrom must be before dateTo');
  }

  // Number(body.maxPrice) in the route can produce NaN or garbage; stop it
  // here so it never reaches the DB or the extraction prompt.
  if (payload.maxPrice !== null && !isValidPriceAmount(payload.maxPrice)) {
    throw new Error('maxPrice must be a finite non-negative number');
  }

  const combos = origins.length * destinations.length;
  // For continuous one-way ranges (no enumerated outboundDates), expand
  // [dateFrom, dateTo] into per-day samples capped at PREVIEW_MAX_DATES so
  // a +/- N flex query scrapes every day of the window. Round-trip continuous
  // preview stays single-pair to fit the combos * dates <= 24 budget; the
  // cron path does the wider grid.
  const datesToScrape = outboundDates ?? (isOneWay
    ? expandContinuousRangeToDates(dateFrom, dateTo, PREVIEW_MAX_DATES)
    : [dateFrom]);
  const totalTasks = combos * datesToScrape.length;

  if (totalTasks > maxCombos) {
    throw new Error(`Too many date/route combinations (${totalTasks}). Cap is ${maxCombos} (combos x dates).`);
  }

  if (returnDates && outboundDates && !isOneWay && returnDates.length !== outboundDates.length) {
    throw new Error('Return dates must match outbound dates');
  }

  return { origins, destinations, isOneWay };
}

async function scrapeRoute(params: ScrapeRouteParams): Promise<PriceData[]> {
  const { origin, destination, dateFrom, dateTo, dateFromStr, cabinClass, tripType } = params;

  const searchParams = { origin, destination, dateFrom, dateTo, cabinClass, tripType, currency: params.currency };
  const airlines = params.preferredAirlines;
  const directAirline = airlines.length === 1 && isKnownAirline(airlines[0]!) ? airlines[0]! : null;
  const filters = {
    maxPrice: params.maxPrice,
    maxStops: params.maxStops,
    maxDurationHours: params.maxDurationHours,
    preferredAirlines: airlines,
    timePreference: params.timePreference,
    cabinClass,
  };

  const { provider, model, costs } = params.context;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastFailureReason: ExtractionFailureReason | undefined;
  let lastSource = 'google_flights';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[preview] ${origin}->${destination} attempt ${attempt}/${MAX_ATTEMPTS}`);

    let nav;
    try {
      nav = directAirline
        ? await navigateAirlineDirect(searchParams, directAirline)
        : await navigateGoogleFlights(searchParams);
    } catch {
      // Airline-direct navigation failed; fall back to Google Flights.
      nav = await navigateGoogleFlights(searchParams);
    }

    lastSource = nav.source;

    const { prices: extracted, usage, failureReason } = await extractPrices(
      nav.html,
      nav.url,
      dateFromStr,
      filters,
      PREVIEW_MAX_RESULTS,
      nav.resultsFound,
      nav.source,
      params.currency,
      {
        provider: params.context.provider,
        model: params.context.model,
        customBaseUrl: params.context.customBaseUrl,
        extractTimeoutSeconds: params.context.extractTimeoutSeconds,
        apiKey: params.context.apiKey,
      }
    );

    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;

    if (!failureReason) {
      const cost =
        (totalInputTokens / 1000) * costs.costPer1kInput +
        (totalOutputTokens / 1000) * costs.costPer1kOutput;

      await prisma.apiUsageLog.create({
        data: {
          provider,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: cost,
          operation: 'preview-flights',
          durationMs: 0,
        },
      });

      console.log(`[preview] ${origin}->${destination} OK - ${extracted.length} flights (attempt ${attempt})`);
      return extracted;
    }

    lastFailureReason = failureReason;

    try {
      await mkdir(DEBUG_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // taskIndex + dateFromStr disambiguate concurrent same-route writes
      // (issue 65 audit finding A4). Two workers scraping JFK to LAX on
      // different dates in the same millisecond can no longer overwrite
      // each other's debug HTML.
      const path = `${DEBUG_DIR}/preview-task${params.taskIndex}-${origin}-${destination}-${dateFromStr}-attempt${attempt}-${ts}.html`;
      await writeFile(path, nav.html, 'utf-8');
      console.log(`[preview] saved debug HTML -> ${path} (${nav.html.length} chars)`);
    } catch {
      // ignore write errors
    }

    if (attempt < MAX_ATTEMPTS && RETRYABLE_FAILURES.includes(failureReason)) {
      const delay = 5000 + Math.random() * 5000;
      console.log(`[preview] ${origin}->${destination} retrying after ${Math.round(delay)}ms (reason: ${failureReason})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
  }

  const totalCost =
    (totalInputTokens / 1000) * costs.costPer1kInput +
    (totalOutputTokens / 1000) * costs.costPer1kOutput;

  await prisma.apiUsageLog.create({
    data: {
      provider,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCost,
      operation: 'preview-flights',
      durationMs: 0,
      error: `[${lastFailureReason}] ${origin} -> ${destination}`,
    },
  });

  const sourceName = lastSource === 'airline_direct' ? 'The airline website' : 'Google Flights';
  const messages: Record<string, string> = {
    page_not_loaded: `${sourceName} did not load results - blocked or CAPTCHA'd`,
    no_json_in_response: `Could not extract flight data from ${sourceName}`,
    empty_extraction: `No flights found - ${sourceName} may be rate-limiting`,
    all_filtered_out: 'Flights exist but none matched your filters',
    llm_error: 'Extraction provider failed (timeout or rate limit). Try again in a moment.',
    json_parse_error: 'Extraction provider returned malformed output. Try again in a moment.',
  };

  throw new Error(messages[lastFailureReason!] ?? 'Flight extraction failed');
}

export async function runPreview(
  payload: PreviewRequestPayload,
  options: RunPreviewOptions = {}
): Promise<PreviewResultPayload> {
  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const { origins, destinations, isOneWay } = validatePreviewPayload(payload, config?.previewMaxCombos ?? 24);
  const { dateFrom, dateTo, maxPrice, maxStops, maxDurationHours, preferredAirlines, timePreference, cabinClass, tripType, currency: bodyCurrency } = payload;
  const currency: string | null = config?.defaultCurrency ?? bodyCurrency;
  const provider = config?.provider ?? 'anthropic';
  const model = config?.model ?? 'claude-haiku-4-5-20251001';
  const context: ExtractionContext = {
    provider,
    model,
    customBaseUrl: config?.customBaseUrl ?? null,
    extractTimeoutSeconds: config?.extractTimeoutSeconds ?? null,
    apiKey: resolveApiKey(provider, config),
    costs: getModelCosts(provider, model),
  };
  const outboundDates = payload.outboundDates;
  const returnDates = payload.returnDates;

  const combos: Array<{ origin: Airport; destination: Airport }> = [];
  for (const origin of origins) {
    for (const destination of destinations) {
      combos.push({ origin, destination });
    }
  }

  const datesToScrape = outboundDates ?? (isOneWay
    ? expandContinuousRangeToDates(dateFrom, dateTo, PREVIEW_MAX_DATES)
    : [dateFrom]);
  const tasks: Array<{ combo: { origin: Airport; destination: Airport }; outboundDate: string; returnDate: string }> = [];

  for (const combo of combos) {
    for (let i = 0; i < datesToScrape.length; i++) {
      const outboundDate = datesToScrape[i]!;
      const resolvedReturnDate = isOneWay ? outboundDate : (returnDates?.[i] ?? dateTo);
      tasks.push({
        combo,
        outboundDate,
        returnDate: resolvedReturnDate,
      });
    }
  }

  const routes: RouteResult[] = new Array(tasks.length);
  let nextIndex = 0;

  const runOne = async (taskIndex: number): Promise<void> => {
    const task = tasks[taskIndex]!;
    const { combo, outboundDate, returnDate } = task;
    const taskFrom = new Date(outboundDate + 'T00:00:00Z');
    const taskTo = new Date(returnDate + 'T00:00:00Z');
    const cacheKey = buildCacheKey(
      combo.origin.code,
      combo.destination.code,
      outboundDate,
      returnDate,
      cabinClass || 'economy',
      tripType || 'round_trip',
      currency
    );

    try {
      const flights = await cached<PriceData[]>(cacheKey, () =>
        scrapeRoute({
          origin: combo.origin.code,
          destination: combo.destination.code,
          dateFrom: taskFrom,
          dateTo: taskTo,
          dateFromStr: outboundDate,
          cabinClass: cabinClass || 'economy',
          tripType: tripType || 'round_trip',
          maxPrice: maxPrice ? Number(maxPrice) : null,
          maxStops: maxStops !== undefined && maxStops !== null ? Number(maxStops) : null,
          maxDurationHours,
          preferredAirlines,
          timePreference: timePreference || 'any',
          currency,
          context,
          taskIndex,
        })
      );

      routes[taskIndex] = {
        origin: combo.origin.code,
        originName: combo.origin.name,
        destination: combo.destination.code,
        destinationName: combo.destination.name,
        flights,
        date: outboundDate,
        returnDate,
      };
    } catch (error) {
      routes[taskIndex] = {
        origin: combo.origin.code,
        originName: combo.origin.name,
        destination: combo.destination.code,
        destinationName: combo.destination.name,
        flights: [],
        date: outboundDate,
        returnDate,
        error: error instanceof Error ? error.message : 'Failed to search this route',
      };
    }

    if (options.onTaskComplete) {
      try {
        await options.onTaskComplete();
      } catch (callbackError) {
        console.error('[preview] onTaskComplete callback threw', callbackError);
      }
    }
  };

  // Worker pool: each worker pulls the next index off the shared counter
  // and writes its result into a preallocated slot, so output order
  // matches input task order regardless of which worker finishes first.
  // JS is single threaded, so nextIndex++ is atomic.
  const concurrency = Math.max(1, Math.min(options.concurrency ?? PREVIEW_CONCURRENCY, tasks.length));
  const worker = async () => {
    while (true) {
      const taskIndex = nextIndex++;
      if (taskIndex >= tasks.length) return;
      await runOne(taskIndex);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (!routes.some((route) => route.flights.length > 0)) {
    const firstError = routes.find((route) => route.error)?.error ?? 'No flights found for any route';
    throw new Error(firstError);
  }

  if (routes.length === 1) {
    return { flights: routes[0]!.flights, routes };
  }

  return { routes };
}
