/**
 * Tests for the runPreview worker pool: parallelism gate, heartbeat
 * callback, output ordering, and the extractionConfig hoist invariant.
 * scrapeRoute is intercepted by mocking its three dependencies
 * (navigate*, extractPrices, prisma) plus the cached wrapper so the test
 * controls timing without touching the network or a real Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PreviewRequestPayload } from '@/lib/preview-run';

const {
  mockExtractionConfigFindFirst,
  mockApiUsageLogCreate,
  mockExtractPrices,
  mockNavigateGoogleFlights,
  mockNavigateAirlineDirect,
} = vi.hoisted(() => ({
  mockExtractionConfigFindFirst: vi.fn(),
  mockApiUsageLogCreate: vi.fn().mockResolvedValue({}),
  mockExtractPrices: vi.fn(),
  mockNavigateGoogleFlights: vi.fn(),
  mockNavigateAirlineDirect: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: { findFirst: mockExtractionConfigFindFirst },
    apiUsageLog: { create: mockApiUsageLogCreate },
  },
}));

// Bypass Redis: just call the inner factory. Dogpile protection is not
// in scope; each task in a single runPreview has a unique cache key.
vi.mock('@/lib/redis', () => ({
  cached: <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('@/lib/scraper/navigate', () => ({
  navigateGoogleFlights: mockNavigateGoogleFlights,
  navigateAirlineDirect: mockNavigateAirlineDirect,
}));

vi.mock('@/lib/scraper/extract-prices', () => ({
  extractPrices: mockExtractPrices,
}));

vi.mock('@/lib/scraper/airline-urls', () => ({
  isKnownAirline: () => false,
}));

import { runPreview } from './preview-runner';

function makePayload(overrides: Partial<PreviewRequestPayload> = {}): PreviewRequestPayload {
  return {
    dateFrom: '2026-11-09',
    dateTo: '2026-11-09',
    maxPrice: null,
    maxStops: null,
    maxDurationHours: null,
    preferredAirlines: [],
    timePreference: 'any',
    cabinClass: 'economy',
    tripType: 'one_way',
    currency: 'USD',
    origins: [{ code: 'JFK', name: 'New York' }],
    destinations: [{ code: 'LAX', name: 'Los Angeles' }],
    ...overrides,
  };
}

function priceData(airline: string, price: number) {
  return {
    airline,
    price,
    currency: 'USD',
    duration: '5h 30m',
    stops: 0,
    bookingUrl: 'https://example.com',
    flightId: null,
    flightNumber: null,
    timestamps: { departure: null, arrival: null },
  };
}

beforeEach(() => {
  mockExtractionConfigFindFirst.mockReset();
  mockApiUsageLogCreate.mockClear();
  mockExtractPrices.mockReset();
  mockNavigateGoogleFlights.mockReset();
  mockNavigateAirlineDirect.mockReset();

  mockExtractionConfigFindFirst.mockResolvedValue({
    id: 'singleton',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    defaultCurrency: 'USD',
  });
  mockNavigateGoogleFlights.mockResolvedValue({
    html: '<html></html>',
    url: 'https://google.com/flights',
    source: 'google_flights',
    resultsFound: true,
  });
  mockExtractPrices.mockResolvedValue({
    prices: [priceData('AA', 250)],
    usage: { inputTokens: 100, outputTokens: 50 },
    failureReason: undefined,
  });
});

describe('runPreview hoist invariant', () => {
  it('reads extractionConfig exactly once across many tasks (issue #65 hoist)', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }, { code: 'EWR', name: 'B' }],
      destinations: [{ code: 'LAX', name: 'C' }, { code: 'SFO', name: 'D' }],
      tripType: 'one_way',
      dateFrom: '2026-11-09',
      dateTo: '2026-11-13',
    });

    await runPreview(payload, { concurrency: 4 });

    // Before the hoist this would have been called 3 * tasks times (1 for
    // the cost calc plus 2 in the failure path of every scrapeRoute).
    expect(mockExtractionConfigFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe('runPreview heartbeat invariant', () => {
  it('invokes onTaskComplete once per task (success path)', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }, { code: 'EWR', name: 'B' }],
      destinations: [{ code: 'LAX', name: 'C' }],
      dateFrom: '2026-11-09',
      dateTo: '2026-11-11',
      tripType: 'one_way',
    });

    const onTaskComplete = vi.fn();
    await runPreview(payload, { onTaskComplete, concurrency: 1 });

    // 2 origins x 1 destination x 3 dates = 6 tasks
    expect(onTaskComplete).toHaveBeenCalledTimes(6);
  });

  it('invokes onTaskComplete on failure path too', async () => {
    // all_filtered_out is non-retryable, so the scrapeRoute throws on
    // the first attempt without waiting on the random 5-10s backoff
    // that retryable reasons trigger.
    mockExtractPrices.mockResolvedValue({
      prices: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      failureReason: 'all_filtered_out',
    });

    const onTaskComplete = vi.fn();
    const payload = makePayload();
    await expect(runPreview(payload, { onTaskComplete })).rejects.toThrow();
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('swallows errors thrown from onTaskComplete and keeps running', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }],
      destinations: [{ code: 'LAX', name: 'C' }, { code: 'SFO', name: 'D' }],
    });

    const onTaskComplete = vi.fn().mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPreview(payload, { onTaskComplete, concurrency: 1 });
    expect(result.routes).toHaveLength(2);
    expect(onTaskComplete).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('runPreview parallelism gate', () => {
  /**
   * Instrument navigateGoogleFlights so each call signals start, waits on
   * a release barrier, and signals finish. The test then asserts peak
   * concurrent in-flight calls equals the configured ceiling.
   */
  function instrumentedNavigate() {
    let inFlight = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];
    mockNavigateGoogleFlights.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releasers.push(resolve));
      inFlight--;
      return {
        html: '<html></html>',
        url: 'https://google.com/flights',
        source: 'google_flights',
        resultsFound: true,
      };
    });
    const releaseAll = () => releasers.forEach((r) => r());
    const releaseOne = () => releasers.shift()?.();
    return { getPeak: () => peak, getInFlight: () => inFlight, releaseAll, releaseOne, getPending: () => releasers.length };
  }

  it('caps in flight scrapeRoute calls at the configured concurrency', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }, { code: 'EWR', name: 'B' }, { code: 'LGA', name: 'L' }],
      destinations: [{ code: 'LAX', name: 'C' }, { code: 'SFO', name: 'D' }],
      tripType: 'one_way',
    });
    // 3 x 2 x 1 = 6 tasks

    const probe = instrumentedNavigate();
    const promise = runPreview(payload, { concurrency: 3 });

    // Yield enough microtasks for the first batch of workers to enter
    // navigateGoogleFlights and bump inFlight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(probe.getInFlight()).toBe(3);
    expect(probe.getPending()).toBe(3);

    probe.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // After releasing the first wave, the next 3 should run.
    probe.releaseAll();
    await promise;
    expect(probe.getPeak()).toBe(3);
  });

  it('runs serially when concurrency=1 (regression for opt out)', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }, { code: 'EWR', name: 'B' }],
      destinations: [{ code: 'LAX', name: 'C' }],
    });

    const probe = instrumentedNavigate();
    const promise = runPreview(payload, { concurrency: 1 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(probe.getInFlight()).toBe(1);

    probe.releaseOne();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(probe.getInFlight()).toBe(1);

    probe.releaseAll();
    await promise;
    expect(probe.getPeak()).toBe(1);
  });
});

describe('runPreview output ordering', () => {
  it('preserves input task order even when workers finish out of order', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'JFK Name' }, { code: 'EWR', name: 'EWR Name' }, { code: 'LGA', name: 'LGA Name' }],
      destinations: [{ code: 'LAX', name: 'LAX Name' }],
      tripType: 'one_way',
    });

    // Make the EWR call (task index 1) resolve slowest so it would land
    // out of order in a push based implementation.
    mockNavigateGoogleFlights.mockImplementation(async ({ origin }: { origin: string }) => {
      const delay = origin === 'EWR' ? 50 : 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        html: '<html></html>',
        url: 'https://google.com/flights',
        source: 'google_flights',
        resultsFound: true,
      };
    });

    const result = await runPreview(payload, { concurrency: 3 });
    expect(result.routes.map((r) => r.origin)).toEqual(['JFK', 'EWR', 'LGA']);
  });
});
