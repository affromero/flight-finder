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
  mockWriteFile,
  mockMkdir,
  mockRedisIncr,
  mockRedisDecr,
  mockRedisExpire,
  mockRedisSet,
} = vi.hoisted(() => ({
  mockExtractionConfigFindFirst: vi.fn(),
  mockApiUsageLogCreate: vi.fn().mockResolvedValue({}),
  mockExtractPrices: vi.fn(),
  mockNavigateGoogleFlights: vi.fn(),
  mockNavigateAirlineDirect: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockRedisIncr: vi.fn(),
  mockRedisDecr: vi.fn(),
  mockRedisExpire: vi.fn().mockResolvedValue(1),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
}));

vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: { findFirst: mockExtractionConfigFindFirst },
    apiUsageLog: { create: mockApiUsageLogCreate },
  },
}));

// Bypass the cache wrapper: just call the inner factory. Dogpile protection
// is not in scope; each task in a single runPreview has a unique cache key.
// The redis client itself is a controllable stub so the admission gate tests
// can drive INCR/DECR at the boundary instead of standing up a real Redis.
vi.mock('@/lib/redis', () => ({
  cached: <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
  redis: {
    incr: mockRedisIncr,
    decr: mockRedisDecr,
    expire: mockRedisExpire,
    set: mockRedisSet,
  },
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

import {
  runPreview,
  parsePreviewConcurrency,
  validatePreviewPayload,
  acquirePreviewAdmission,
  releasePreviewAdmission,
} from './preview-runner';

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
  mockWriteFile.mockClear();
  mockMkdir.mockClear();
  mockRedisIncr.mockReset();
  mockRedisDecr.mockReset();
  mockRedisExpire.mockClear();
  mockRedisSet.mockClear();
  mockRedisExpire.mockResolvedValue(1);
  mockRedisSet.mockResolvedValue('OK');

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
   * Deterministic barrier instrumentation (audit C1). Each navigate
   * call signals "I have started" via a resolve hook, waits on a
   * release barrier, then signals finish. The waitForInFlight helper
   * is event driven instead of setTimeout polled, so tests do not
   * depend on real wall clock progress and are not flaky on slow CI.
   */
  function instrumentedNavigate() {
    let inFlight = 0;
    let peak = 0;
    let autoRelease = false;
    const releasers: Array<() => void> = [];
    const startWatchers: Array<{ target: number; resolve: () => void }> = [];

    const notifyStart = () => {
      for (let i = startWatchers.length - 1; i >= 0; i--) {
        if (inFlight >= startWatchers[i]!.target) {
          startWatchers[i]!.resolve();
          startWatchers.splice(i, 1);
        }
      }
    };

    mockNavigateGoogleFlights.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      notifyStart();
      if (!autoRelease) {
        await new Promise<void>((resolve) => releasers.push(resolve));
      }
      inFlight--;
      return {
        html: '<html></html>',
        url: 'https://google.com/flights',
        source: 'google_flights',
        resultsFound: true,
      };
    });

    const waitForInFlight = (target: number): Promise<void> => {
      if (inFlight >= target) return Promise.resolve();
      return new Promise<void>((resolve) => startWatchers.push({ target, resolve }));
    };

    return {
      getPeak: () => peak,
      getInFlight: () => inFlight,
      getPending: () => releasers.length,
      releaseAll: () => releasers.splice(0).forEach((r) => r()),
      releaseOne: () => releasers.shift()?.(),
      // Releases all currently pending navigates AND switches future
      // navigate calls to no-await mode. Used to let the worker pool
      // drain to completion after the test has captured the peak.
      drain: () => {
        autoRelease = true;
        releasers.splice(0).forEach((r) => r());
      },
      waitForInFlight,
    };
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

    // Deterministic: wait until 3 workers have entered navigate.
    await probe.waitForInFlight(3);
    expect(probe.getInFlight()).toBe(3);
    // The remaining 3 tasks are queued: no worker has released yet, so
    // only 3 navigates are pending.
    expect(probe.getPending()).toBe(3);

    // Drain the queue to completion. Peak must not have exceeded 3.
    probe.drain();
    await promise;
    expect(probe.getPeak()).toBe(3);
    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(6);
  });

  it('runs serially when concurrency=1 (regression for opt out)', async () => {
    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }, { code: 'EWR', name: 'B' }],
      destinations: [{ code: 'LAX', name: 'C' }],
    });

    const probe = instrumentedNavigate();
    const promise = runPreview(payload, { concurrency: 1 });

    // Single worker active at all times.
    await probe.waitForInFlight(1);
    expect(probe.getInFlight()).toBe(1);
    expect(probe.getPending()).toBe(1);

    probe.drain();
    await promise;
    expect(probe.getPeak()).toBe(1);
    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(2);
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

describe('parsePreviewConcurrency (audit D1)', () => {
  it('defaults to 3 when env is unset', () => {
    expect(parsePreviewConcurrency(undefined)).toBe(3);
  });

  it('returns the parsed value within range', () => {
    expect(parsePreviewConcurrency('1')).toBe(1);
    expect(parsePreviewConcurrency('5')).toBe(5);
    expect(parsePreviewConcurrency('10')).toBe(10);
  });

  it('clamps values above 10 to 10', () => {
    expect(parsePreviewConcurrency('25')).toBe(10);
    expect(parsePreviewConcurrency('1000')).toBe(10);
  });

  it('falls back to 3 on garbage or non positive input', () => {
    expect(parsePreviewConcurrency('garbage')).toBe(3);
    expect(parsePreviewConcurrency('0')).toBe(3);
    expect(parsePreviewConcurrency('-5')).toBe(3);
    expect(parsePreviewConcurrency('')).toBe(3);
  });
});

describe('validatePreviewPayload combo cap (issue #89, configurable)', () => {
  // 5 origins x 6 destinations x 1 date = 30 combos.
  const wideFlexPayload = makePayload({
    tripType: 'one_way',
    dateFrom: '2026-11-09',
    dateTo: '2026-11-09',
    origins: [
      { code: 'JFK', name: 'A' }, { code: 'EWR', name: 'B' }, { code: 'BOS', name: 'C' },
      { code: 'PHL', name: 'D' }, { code: 'BWI', name: 'E' },
    ],
    destinations: [
      { code: 'LAX', name: 'F' }, { code: 'SFO', name: 'G' }, { code: 'SAN', name: 'H' },
      { code: 'SEA', name: 'I' }, { code: 'PDX', name: 'J' }, { code: 'LAS', name: 'K' },
    ],
  });

  it('rejects a 30-combo search under the default cap of 24', () => {
    expect(() => validatePreviewPayload(wideFlexPayload)).toThrow(
      'Too many date/route combinations (30). Cap is 24 (combos x dates).',
    );
  });

  it('accepts the same 30-combo search when the admin raises the cap to 30', () => {
    expect(() => validatePreviewPayload(wideFlexPayload, 30)).not.toThrow();
  });

  it('reports the configured cap in the error message, not a hardcoded 24', () => {
    expect(() => validatePreviewPayload(wideFlexPayload, 12)).toThrow(/Cap is 12/);
  });
});

describe('preview admission gate (audit M5 TOCTOU)', () => {
  /**
   * Drives acquire/release against a single-threaded INCR/DECR counter, the
   * way real Redis behaves. Proves the cap holds across a concurrent burst:
   * the old count-then-create gate let N concurrent requests all read the
   * same pre-insert count and slip past. INCR returns a distinct value to
   * each, so at most `cap` are admitted.
   */
  function backCounterWithRedis(initial = 0) {
    let value = initial;
    mockRedisIncr.mockImplementation(async () => ++value);
    mockRedisDecr.mockImplementation(async () => --value);
    mockRedisSet.mockImplementation(async () => {
      value = 0;
      return 'OK';
    });
    return { get: () => value };
  }

  it('admits at most `cap` requests from a concurrent burst for one IP', async () => {
    const counter = backCounterWithRedis();
    const cap = 3;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => acquirePreviewAdmission('203.0.113.5', cap)),
    );

    const admitted = results.filter((r) => r === 'admitted');
    const rejected = results.filter((r) => r === 'rejected');
    expect(admitted).toHaveLength(cap);
    expect(rejected).toHaveLength(10 - cap);
    // Overshooting requests DECR their own increment back, so the counter
    // settles exactly at the cap, not at 10.
    expect(counter.get()).toBe(cap);
  });

  it('sets the TTL only on the first admission for an IP', async () => {
    backCounterWithRedis();

    await acquirePreviewAdmission('198.51.100.1', 5);
    await acquirePreviewAdmission('198.51.100.1', 5);

    // EXPIRE only fires when INCR returns 1 (the slot was freshly created),
    // so a long-lived counter is not perpetually reset by later admissions.
    expect(mockRedisExpire).toHaveBeenCalledTimes(1);
  });

  it('frees a slot on release so a later request is admitted again', async () => {
    const counter = backCounterWithRedis();
    const cap = 1;

    expect(await acquirePreviewAdmission('203.0.113.9', cap)).toBe('admitted');
    expect(await acquirePreviewAdmission('203.0.113.9', cap)).toBe('rejected');

    await releasePreviewAdmission('203.0.113.9');
    expect(counter.get()).toBe(0);

    expect(await acquirePreviewAdmission('203.0.113.9', cap)).toBe('admitted');
  });

  it('floors the counter at zero on an over-release', async () => {
    const counter = backCounterWithRedis(0);

    await releasePreviewAdmission('203.0.113.11');

    // DECR from 0 returns -1; the gate resets it to 0 so a stray release
    // cannot hand the client extra capacity.
    expect(mockRedisSet).toHaveBeenCalled();
    expect(counter.get()).toBe(0);
  });

  it('fails open to unavailable when INCR throws (so previews are not hard-blocked)', async () => {
    mockRedisIncr.mockRejectedValue(new Error('redis down'));

    const result = await acquirePreviewAdmission('203.0.113.13', 3);

    expect(result).toBe('unavailable');
  });
});

describe('runPreview debug filename uniqueness (audit A4)', () => {
  it('writes per task debug paths that encode taskIndex and dateFromStr', async () => {
    // Force the failure branch so the debug write path runs.
    // all_filtered_out is non retryable, so we settle on attempt 1
    // and avoid the 5-10s retry backoff.
    mockExtractPrices.mockResolvedValue({
      prices: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      failureReason: 'all_filtered_out',
    });

    const payload = makePayload({
      origins: [{ code: 'JFK', name: 'A' }],
      destinations: [{ code: 'LAX', name: 'B' }],
      tripType: 'one_way',
      dateFrom: '2026-11-09',
      dateTo: '2026-11-10',
    });

    await expect(runPreview(payload, { concurrency: 2 })).rejects.toThrow();

    const paths = mockWriteFile.mock.calls.map((call) => call[0] as string);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    // Every path includes the taskN tag so two workers cannot collide.
    expect(paths.every((p) => /\/preview-task\d+-/.test(p))).toBe(true);
    // Each task's date appears in its own path.
    expect(paths.some((p) => p.includes('-2026-11-09-'))).toBe(true);
    expect(paths.some((p) => p.includes('-2026-11-10-'))).toBe(true);
    // Unique paths overall, regardless of timestamp collision.
    expect(new Set(paths).size).toBe(paths.length);
  });
});
