import { mkdir, writeFile } from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { navigateGoogleFlights, navigateAirlineDirect } from '../../../../apps/web/src/lib/scraper/navigate.js';
import { extractPrices, type PriceData, type ExtractionFailureReason } from '../../../../apps/web/src/lib/scraper/extract-prices.js';
import { getModelCosts } from '../../../../apps/web/src/lib/scraper/ai-registry.js';
import { isKnownAirline } from '../../../../apps/web/src/lib/scraper/airline-urls.js';
import type { Airport, ParsedFlightQuery } from '../../../../apps/web/src/lib/scraper/parse-query.js';

export type { PriceData, Airport };

const RETRYABLE_FAILURES: ExtractionFailureReason[] = ['empty_extraction', 'page_not_loaded', 'no_json_in_response'];
const MAX_ATTEMPTS = 2;
const DEBUG_DIR = '/tmp/flight-finder-debug';
const PREVIEW_MAX_RESULTS = 20;

export interface RouteResult {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  flights: PriceData[];
  date?: string;
  error?: string;
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
}

async function scrapeRoute(params: ScrapeRouteParams): Promise<PriceData[]> {
  const { origin, destination, dateFrom, dateTo, dateFromStr, cabinClass, tripType } = params;

  const searchParams = { origin, destination, dateFrom, dateTo, cabinClass, tripType, currency: params.currency };
  const airlines: string[] = params.preferredAirlines;
  const directAirline = airlines.length === 1 && isKnownAirline(airlines[0]!) ? airlines[0]! : null;
  const filters = {
    maxPrice: params.maxPrice,
    maxStops: params.maxStops,
    maxDurationHours: params.maxDurationHours,
    preferredAirlines: airlines,
    timePreference: params.timePreference,
    cabinClass,
  };

  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const provider = config?.provider ?? 'anthropic';
  const model = config?.model ?? 'claude-haiku-4-5-20251001';
  const costs = getModelCosts(provider, model);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastFailureReason: ExtractionFailureReason | undefined;
  let lastSource: string = 'google_flights';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          provider, model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: cost,
          operation: 'preview-flights',
          durationMs: 0,
        },
      });

      return extracted;
    }

    lastFailureReason = failureReason;

    try {
      await mkdir(DEBUG_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const path = `${DEBUG_DIR}/preview-${origin}-${destination}-attempt${attempt}-${ts}.html`;
      await writeFile(path, nav.html, 'utf-8');
    } catch {
      // ignore write errors
    }

    if (attempt < MAX_ATTEMPTS && RETRYABLE_FAILURES.includes(failureReason)) {
      const delay = 5000 + Math.random() * 5000;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
  }

  const totalCost =
    (totalInputTokens / 1000) * costs.costPer1kInput +
    (totalOutputTokens / 1000) * costs.costPer1kOutput;

  await prisma.apiUsageLog.create({
    data: {
      provider: (await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } }))?.provider ?? 'anthropic',
      model: (await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } }))?.model ?? 'claude-haiku-4-5-20251001',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCost,
      operation: 'preview-flights',
      durationMs: 0,
      error: `[${lastFailureReason}] ${origin} → ${destination}`,
    },
  });

  const sourceName = lastSource === 'airline_direct' ? 'The airline website' : 'Google Flights';
  const messages: Record<string, string> = {
    page_not_loaded: `${sourceName} did not load results — blocked or CAPTCHA'd`,
    no_json_in_response: `Could not extract flight data from ${sourceName}`,
    empty_extraction: `No flights found — ${sourceName} may be rate-limiting`,
    all_filtered_out: `Flights exist but none matched your filters`,
  };
  throw new Error(messages[lastFailureReason!] ?? 'Flight extraction failed');
}

export interface PreviewParams {
  parsed: ParsedFlightQuery;
  onProgress?: (msg: string) => void;
}

export async function previewFlights({ parsed, onProgress }: PreviewParams): Promise<RouteResult[]> {
  const origins = parsed.origins;
  const destinations = parsed.destinations;
  const outboundDates = parsed.outboundDates ?? [parsed.dateFrom];
  const isOneWay = parsed.tripType === 'one_way';
  const defaultReturnDate = parsed.returnDates?.[0] ?? parsed.dateTo;

  interface ScrapeTask {
    origin: Airport;
    destination: Airport;
    outboundDate: string;
    returnDate: string;
  }

  const tasks: ScrapeTask[] = [];
  for (const o of origins) {
    for (const d of destinations) {
      for (const outDate of outboundDates) {
        tasks.push({
          origin: o,
          destination: d,
          outboundDate: outDate,
          returnDate: isOneWay ? outDate : defaultReturnDate,
        });
      }
    }
  }

  const routes: RouteResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const taskFrom = new Date(task.outboundDate + 'T00:00:00Z');
    const taskTo = new Date(task.returnDate + 'T00:00:00Z');

    onProgress?.(`Route ${i + 1}/${tasks.length}: ${task.origin.code} → ${task.destination.code}`);

    try {
      const flights = await scrapeRoute({
        origin: task.origin.code,
        destination: task.destination.code,
        dateFrom: taskFrom,
        dateTo: taskTo,
        dateFromStr: task.outboundDate,
        cabinClass: parsed.cabinClass || 'economy',
        tripType: parsed.tripType || 'round_trip',
        maxPrice: parsed.maxPrice,
        maxStops: parsed.maxStops,
        maxDurationHours: parsed.maxDurationHours,
        preferredAirlines: parsed.preferredAirlines,
        timePreference: parsed.timePreference || 'any',
        currency: parsed.currency,
      });

      routes.push({
        origin: task.origin.code,
        originName: task.origin.name,
        destination: task.destination.code,
        destinationName: task.destination.name,
        flights,
        date: task.outboundDate,
      });
    } catch (err) {
      routes.push({
        origin: task.origin.code,
        originName: task.origin.name,
        destination: task.destination.code,
        destinationName: task.destination.name,
        flights: [],
        date: task.outboundDate,
        error: err instanceof Error ? err.message : 'Failed to search this route',
      });
    }
  }

  return routes;
}
