import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { cached } from '@/lib/redis';
import {
  ACTIVE_PREVIEW_STATUSES,
  PREVIEW_ACTIVE_TIMEOUT_MS,
  PREVIEW_TIMEOUT_ERROR,
  TERMINAL_PREVIEW_STATUSES,
  type PreviewRequestPayload,
  type PreviewResultPayload,
  type RouteResultPayload,
} from '@/lib/preview-run';
import { getModelCosts } from '@/lib/scraper/ai-registry';
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
const DEBUG_DIR = '/tmp/fairtrail-debug';
const PREVIEW_MAX_RESULTS = 20;
const PREVIEW_RUN_TTL_MS = 24 * 60 * 60 * 1000;

interface PreviewRunRow {
  id: string;
  requestHash: string;
  status: string;
  requestPayload: Prisma.JsonValue;
  resultPayload: Prisma.JsonValue | null;
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface PreviewRunStore {
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<PreviewRunRow>;
  findFirst(args: { where: Record<string, unknown>; orderBy: { createdAt: 'desc' } }): Promise<PreviewRunRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<PreviewRunRow>;
}

const previewRunStore = (prisma as unknown as { previewRun: PreviewRunStore }).previewRun;

export type RouteResult = RouteResultPayload;

/**
 * Resolved extraction context shared across all routes in a single
 * runPreview call. Hoisted out of scrapeRoute (was re-read from the DB
 * three times per route) so a 20 route preview reads the config once
 * instead of 60 times. Parallel workers in runPreview share this same
 * object.
 */
interface ExtractionContext {
  provider: string;
  model: string;
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
}

const PREVIEW_CONCURRENCY = 3;

interface PreviewValidationResult {
  origins: Airport[];
  destinations: Airport[];
  isOneWay: boolean;
}

function buildCacheKey(
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

function buildPreviewRequestHash(payload: PreviewRequestPayload): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function toPreviewRequestPayload(body: Record<string, unknown>): PreviewRequestPayload {
  const origins: Airport[] = Array.isArray(body.origins)
    ? body.origins as Airport[]
    : body.origin ? [{ code: String(body.origin), name: String(body.originName || body.origin) }] : [];
  const destinations: Airport[] = Array.isArray(body.destinations)
    ? body.destinations as Airport[]
    : body.destination ? [{ code: String(body.destination), name: String(body.destinationName || body.destination) }] : [];

  return {
    dateFrom: String(body.dateFrom || ''),
    dateTo: String(body.dateTo || ''),
    maxPrice: body.maxPrice === undefined || body.maxPrice === null ? null : Number(body.maxPrice),
    maxStops: body.maxStops === undefined || body.maxStops === null ? null : Number(body.maxStops),
    maxDurationHours: body.maxDurationHours === undefined || body.maxDurationHours === null ? null : Number(body.maxDurationHours),
    preferredAirlines: Array.isArray(body.preferredAirlines) ? body.preferredAirlines.map(String) : [],
    timePreference: typeof body.timePreference === 'string' ? body.timePreference : 'any',
    cabinClass: typeof body.cabinClass === 'string' ? body.cabinClass : 'economy',
    tripType: typeof body.tripType === 'string' ? body.tripType : 'round_trip',
    currency: typeof body.currency === 'string' && body.currency ? body.currency : null,
    outboundDates: Array.isArray(body.outboundDates) ? body.outboundDates.map(String) : undefined,
    returnDates: Array.isArray(body.returnDates) ? body.returnDates.map(String) : undefined,
    origins: origins.map((airport) => ({ code: airport.code, name: airport.name })),
    destinations: destinations.map((airport) => ({ code: airport.code, name: airport.name })),
    origin: typeof body.origin === 'string' ? body.origin : undefined,
    originName: typeof body.originName === 'string' ? body.originName : undefined,
    destination: typeof body.destination === 'string' ? body.destination : undefined,
    destinationName: typeof body.destinationName === 'string' ? body.destinationName : undefined,
  };
}

function validatePreviewPayload(payload: PreviewRequestPayload): PreviewValidationResult {
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

  if (totalTasks > 24) {
    throw new Error(`Too many date/route combinations (${totalTasks}). Cap is 24 (combos x dates).`);
  }

  if (returnDates && outboundDates && !isOneWay && returnDates.length !== outboundDates.length) {
    throw new Error('Return dates must match outbound dates');
  }

  return { origins, destinations, isOneWay };
}

async function cleanupExpiredPreviewRuns(now = new Date()) {
  await previewRunStore.deleteMany({
    where: {
      status: { in: [...TERMINAL_PREVIEW_STATUSES] },
      expiresAt: { lt: now },
    },
  });
}

async function markStalePreviewRunsFailed(requestHash?: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - PREVIEW_ACTIVE_TIMEOUT_MS);
  await previewRunStore.updateMany({
    where: {
      status: { in: [...ACTIVE_PREVIEW_STATUSES] },
      updatedAt: { lt: staleBefore },
      ...(requestHash ? { requestHash } : {}),
    },
    data: {
      status: 'failed',
      error: PREVIEW_TIMEOUT_ERROR,
    },
  });
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
      params.currency
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
      const path = `${DEBUG_DIR}/preview-${origin}-${destination}-attempt${attempt}-${ts}.html`;
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

async function runPreview(
  payload: PreviewRequestPayload,
  options: RunPreviewOptions = {}
): Promise<PreviewResultPayload> {
  const { origins, destinations, isOneWay } = validatePreviewPayload(payload);
  const { dateFrom, dateTo, maxPrice, maxStops, maxDurationHours, preferredAirlines, timePreference, cabinClass, tripType, currency: bodyCurrency } = payload;
  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const currency: string | null = config?.defaultCurrency ?? bodyCurrency;
  const provider = config?.provider ?? 'anthropic';
  const model = config?.model ?? 'claude-haiku-4-5-20251001';
  const context: ExtractionContext = {
    provider,
    model,
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

async function updatePreviewRun(id: string, data: Record<string, unknown>) {
  try {
    await previewRunStore.update({
      where: { id },
      data,
    });
  } catch (error) {
    console.error(`[preview] failed to update preview run ${id}`, error);
  }
}

async function runPreviewInBackground(id: string, payload: PreviewRequestPayload) {
  await updatePreviewRun(id, { status: 'running', error: null });

  try {
    const result = await runPreview(payload, {
      // Heartbeat: bump updatedAt after every task settles so the backend
      // stale marker in [id]/route.ts and markStalePreviewRunsFailed do
      // not falsely fail healthy long scrapes. Explicit status payload
      // documents intent even though Prisma's @updatedAt fires on any
      // update.
      onTaskComplete: () => updatePreviewRun(id, { status: 'running' }),
    });
    await updatePreviewRun(id, {
      status: 'completed',
      resultPayload: result as unknown as Prisma.InputJsonValue,
      error: null,
      expiresAt: new Date(Date.now() + PREVIEW_RUN_TTL_MS),
    });
  } catch (error) {
    await updatePreviewRun(id, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Failed to preview flights',
      expiresAt: new Date(Date.now() + PREVIEW_RUN_TTL_MS),
    });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const payload = toPreviewRequestPayload(body as Record<string, unknown>);

  try {
    validatePreviewPayload(payload);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid preview request', 400);
  }

  const requestHash = buildPreviewRequestHash(payload);
  const now = new Date();

  await cleanupExpiredPreviewRuns(now);
  await markStalePreviewRunsFailed(requestHash, now);

  const existingRun = await previewRunStore.findFirst({
    where: {
      requestHash,
      status: { in: [...ACTIVE_PREVIEW_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existingRun) {
    return apiSuccess({
      previewRunId: existingRun.id,
      status: existingRun.status,
      expiresAt: existingRun.expiresAt.toISOString(),
    }, 202);
  }

  const previewRun = await previewRunStore.create({
    data: {
      requestHash,
      status: 'pending',
      requestPayload: payload as unknown as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + PREVIEW_RUN_TTL_MS),
    },
  });

  void runPreviewInBackground(previewRun.id, payload);

  return apiSuccess({
    previewRunId: previewRun.id,
    status: previewRun.status,
    expiresAt: previewRun.expiresAt.toISOString(),
  }, 202);
}
