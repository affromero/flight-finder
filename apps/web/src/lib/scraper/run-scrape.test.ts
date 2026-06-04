import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const { mockPrisma, mockNavigateGoogleFlights, mockNavigateAirlineDirect, mockNavigateSkyscanner, mockNavigateKayak, mockExtractPrices, mockIsKnownAirline } = vi.hoisted(() => {
  const mockPrisma = {
    query: { findUnique: vi.fn() },
    fetchRun: { create: vi.fn(), update: vi.fn() },
    extractionConfig: { findFirst: vi.fn() },
    priceSnapshot: { createMany: vi.fn(), findMany: vi.fn() },
    apiUsageLog: { create: vi.fn() },
  };
  const mockNavigateGoogleFlights = vi.fn();
  const mockNavigateAirlineDirect = vi.fn();
  const mockNavigateSkyscanner = vi.fn();
  const mockNavigateKayak = vi.fn();
  const mockExtractPrices = vi.fn();
  const mockIsKnownAirline = vi.fn();
  return { mockPrisma, mockNavigateGoogleFlights, mockNavigateAirlineDirect, mockNavigateSkyscanner, mockNavigateKayak, mockExtractPrices, mockIsKnownAirline };
});

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

vi.mock('./navigate', () => ({
  navigateGoogleFlights: (...args: unknown[]) => mockNavigateGoogleFlights(...args),
  navigateAirlineDirect: (...args: unknown[]) => mockNavigateAirlineDirect(...args),
  navigateSkyscanner: (...args: unknown[]) => mockNavigateSkyscanner(...args),
  navigateKayak: (...args: unknown[]) => mockNavigateKayak(...args),
}));

vi.mock('./extract-prices', () => ({
  extractPrices: (...args: unknown[]) => mockExtractPrices(...args),
}));

vi.mock('./ai-registry', () => ({
  getModelCosts: vi.fn().mockReturnValue({ costPer1kInput: 0, costPer1kOutput: 0 }),
}));

vi.mock('./airline-urls', () => ({
  isKnownAirline: (...args: unknown[]) => mockIsKnownAirline(...args),
}));

vi.mock('./country-profiles', () => ({
  getCountryProfile: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./vpn', () => ({
  createVpnProvider: vi.fn().mockReturnValue({
    type: 'none',
    getStatus: vi.fn().mockResolvedValue({ connected: false, currentLocation: null, currentCountry: null }),
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listLocations: vi.fn().mockResolvedValue([]),
    isSystemWide: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { runScrapeForQuery, runScrapeAll } from './run-scrape';

describe('runScrapeAll pause gate (issue #106)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips the entire run when scraping is paused (config.enabled=false)', async () => {
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({ enabled: false });
    const results = await runScrapeAll();
    expect(results).toEqual([]);
    expect(mockPrisma.query.findUnique).not.toHaveBeenCalled();
  });
});

const BASE_QUERY = {
  id: 'q1',
  active: true,
  isSeed: false,
  origin: 'JFK',
  destination: 'LAX',
  dateFrom: new Date('2026-06-15'),
  dateTo: new Date('2026-06-20'),
  cabinClass: 'economy',
  tripType: 'round_trip',
  currency: null,
  preferredAirlines: [],
  preferredAggregators: [] as string[],
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  timePreference: 'any',
  flexibility: 0,
  lookAheadDays: 14,
  expiresAt: new Date('2027-01-01'),
  vpnCountries: [],
  user: null as { preferredAggregators: string[] } | null,
};

describe('runScrapeForQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsKnownAirline.mockReturnValue(false);
    mockPrisma.query.findUnique.mockResolvedValue(BASE_QUERY);
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
  });

  it('stores empty-string bookingUrl when extractPrices coerced null to empty string', async () => {
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15',
        price: 350,
        currency: 'USD',
        airline: 'Delta',
        bookingUrl: '',
        stops: 0,
        duration: '5h',
        departureTime: null,
        arrivalTime: null,
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(result.snapshotsCount).toBe(1);
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ bookingUrl: '' }),
      ]),
    });
  });

  it('marks previously available flight as sold_out when it disappears', async () => {
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([{
      flightId: 'Delta-1025-JFK-LAX-2026-06-15',
      price: 350,
      airline: 'Delta',
      travelDate: new Date('2026-06-15'),
      currency: 'USD',
      bookingUrl: 'https://example.com',
      stops: 0,
      duration: '5h',
      departureTime: '10:25 AM',
      arrivalTime: '3:25 PM',
      status: 'available',
    }]);

    // Extraction returns a different flight — the previous one disappeared
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15',
        price: 400,
        currency: 'USD',
        airline: 'United',
        bookingUrl: '',
        stops: 1,
        duration: '7h',
        departureTime: '2:00 PM',
        arrivalTime: '5:30 PM',
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    // createMany is called twice: once for available flights, once for sold-out
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          flightId: 'Delta-1025-JFK-LAX-2026-06-15',
          status: 'sold_out',
        }),
      ]),
    });
  });

  it('does not create duplicate sold_out snapshot for already sold-out flight', async () => {
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([{
      flightId: 'Delta-1025-JFK-LAX-2026-06-15',
      price: 350,
      airline: 'Delta',
      travelDate: new Date('2026-06-15'),
      currency: 'USD',
      bookingUrl: 'https://example.com',
      stops: 0,
      duration: '5h',
      departureTime: '10:25 AM',
      arrivalTime: '3:25 PM',
      status: 'sold_out',
    }]);

    // Extraction returns a different flight — the sold-out one is still missing
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15',
        price: 400,
        currency: 'USD',
        airline: 'United',
        bookingUrl: '',
        stops: 1,
        duration: '7h',
        departureTime: '2:00 PM',
        arrivalTime: '5:30 PM',
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    // createMany called only once — for the available United flight, NOT for sold-out Delta
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ airline: 'United' }),
      ]),
    });
  });

  it('does not mark legacy-id snapshot as sold_out when same flight comes back with a flight number', async () => {
    // Existing row was persisted before the flightNumber rollout, so its
    // flightId is the legacy time-only form.
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([{
      flightId: 'Delta-1025-JFK-LAX-2026-06-15',
      flightNumber: null,
      price: 350,
      airline: 'Delta',
      travelDate: new Date('2026-06-15'),
      currency: 'USD',
      bookingUrl: 'https://example.com',
      stops: 0,
      duration: '5h',
      departureTime: '10:25 AM',
      arrivalTime: '3:25 PM',
      status: 'available',
    }]);

    // The new extraction returns the same physical flight (same airline, same
    // departure time) but now carries the real flight number, so the new
    // synthesis tail is DL345 instead of 1025.
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15',
        price: 360,
        currency: 'USD',
        airline: 'Delta',
        bookingUrl: 'https://delta.com',
        stops: 0,
        duration: '5h',
        departureTime: '10:25 AM',
        arrivalTime: '3:25 PM',
        seatsLeft: 4,
        flightNumber: 'DL 345',
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    // createMany must be called once (the new available row) and NOT a second
    // time for sold-out — otherwise every existing flight at deploy would be
    // flagged as sold-out.
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          airline: 'Delta',
          flightNumber: 'DL 345',
          flightId: 'Delta-DL345-JFK-LAX-2026-06-15',
        }),
      ]),
    });
  });

  it('accepts null bookingUrl without error (schema is String?)', async () => {
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15',
        price: 350,
        currency: 'USD',
        airline: 'Delta',
        bookingUrl: null,
        stops: 0,
        duration: '5h',
        departureTime: null,
        arrivalTime: null,
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(mockPrisma.priceSnapshot.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ bookingUrl: null }),
      ]),
    });
  });
});

describe('runScrapeForQuery multi-pair date expansion (issue #65)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-11-07',
        price: 350,
        currency: 'USD',
        airline: 'Delta',
        bookingUrl: '',
        stops: 0,
        duration: '5h',
        departureTime: null,
        arrivalTime: null,
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('one-way query with flex=2 calls navigate 5 times for the 5-day window', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'one_way',
      dateFrom: new Date('2026-11-07'),
      dateTo: new Date('2026-11-11'),
      flexibility: 2,
    });

    await runScrapeForQuery('q1');

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(5);
    const dates = mockNavigateGoogleFlights.mock.calls.map((call) => {
      const params = call[0] as { dateFrom: Date };
      return params.dateFrom.toISOString().slice(0, 10);
    });
    expect(dates).toEqual(['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']);
  });

  it('round-trip flex>0 still calls navigate once (single (dateFrom, dateTo) pair)', async () => {
    // RT iteration is deferred until flightId/dedupe gain return-date awareness.
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'round_trip',
      dateFrom: new Date('2026-06-13'),
      dateTo: new Date('2026-06-24'),
      flexibility: 2,
    });

    await runScrapeForQuery('q1');

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
  });

  it('creates a single FetchRun for a multi-pair scrape', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'one_way',
      dateFrom: new Date('2026-11-07'),
      dateTo: new Date('2026-11-09'),
      flexibility: 1,
    });

    await runScrapeForQuery('q1');

    expect(mockPrisma.fetchRun.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.fetchRun.update).toHaveBeenCalledTimes(1);
  });

  it('flex=0 keeps single-pair behavior (no regression for non-flex queries)', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'one_way',
      dateFrom: new Date('2026-06-15'),
      dateTo: new Date('2026-06-15'),
      flexibility: 0,
    });

    await runScrapeForQuery('q1');

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
  });
});

describe('runScrapeForQuery sold-out scoping (issue #65)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
  });

  it('does not flag sold-out when the pair scrape itself failed (audit blocker)', async () => {
    // A failed pair (page_not_loaded, llm_error, etc.) must not mark prior
    // snapshots for that date as sold_out, because we did not actually
    // verify availability.
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'one_way',
      dateFrom: new Date('2026-11-07'),
      dateTo: new Date('2026-11-07'),
      flexibility: 0,
    });

    mockPrisma.priceSnapshot.findMany.mockResolvedValue([{
      flightId: 'Delta-1025-JFK-LAX-2026-11-07',
      flightNumber: null,
      price: 350,
      airline: 'Delta',
      travelDate: new Date('2026-11-07'),
      currency: 'USD',
      bookingUrl: 'https://example.com',
      stops: 0,
      duration: '5h',
      departureTime: '10:25 AM',
      arrivalTime: '3:25 PM',
      status: 'available',
    }]);

    // Pair scrape returns failureReason on every attempt (no prices).
    mockExtractPrices.mockResolvedValue({
      prices: [],
      usage: { inputTokens: 100, outputTokens: 20 },
      failureReason: 'page_not_loaded',
    });

    await runScrapeForQuery('q1');

    // No createMany call should mark the prior Delta flight as sold_out
    // because the pair did not produce any prices.
    const soldOutCall = mockPrisma.priceSnapshot.createMany.mock.calls.find((call) =>
      Array.isArray(call[0]?.data) && call[0].data.some((row: { status?: string }) => row.status === 'sold_out')
    );
    expect(soldOutCall).toBeUndefined();
  }, 15_000);

  it('does not flag sold-out for prior dates outside the scraped pair set', async () => {
    // Query covers Nov 7..Nov 9 (one-way flex=1, 3-day window).
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'one_way',
      dateFrom: new Date('2026-11-07'),
      dateTo: new Date('2026-11-09'),
      flexibility: 1,
    });

    // Prior snapshots include Nov 5 (out of range) and Nov 7 (in range).
    // Both have status=available. Nov 7 has a flight that disappears in the
    // current scrape; Nov 5 is from a previous wider-window scrape.
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([
      {
        flightId: 'Delta-1025-JFK-LAX-2026-11-05',
        flightNumber: null,
        price: 300,
        airline: 'Delta',
        travelDate: new Date('2026-11-05'),
        currency: 'USD',
        bookingUrl: 'https://example.com',
        stops: 0,
        duration: '5h',
        departureTime: '10:25 AM',
        arrivalTime: '3:25 PM',
        status: 'available',
      },
      {
        flightId: 'Delta-1025-JFK-LAX-2026-11-07',
        flightNumber: null,
        price: 350,
        airline: 'Delta',
        travelDate: new Date('2026-11-07'),
        currency: 'USD',
        bookingUrl: 'https://example.com',
        stops: 0,
        duration: '5h',
        departureTime: '10:25 AM',
        arrivalTime: '3:25 PM',
        status: 'available',
      },
    ]);

    // The current scrape returns United (different from the existing Delta flights).
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-11-07',
        price: 400,
        currency: 'USD',
        airline: 'United',
        bookingUrl: '',
        stops: 1,
        duration: '7h',
        departureTime: '2:00 PM',
        arrivalTime: '5:30 PM',
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    await runScrapeForQuery('q1');

    // createMany is called for each pair's available rows (3 pairs x 1 flight = 3 calls)
    // plus once for sold-out. Verify that the sold-out call only marks Nov 7 (in range),
    // never Nov 5 (out of range).
    const soldOutCall = mockPrisma.priceSnapshot.createMany.mock.calls.find((call) =>
      Array.isArray(call[0]?.data) && call[0].data.some((row: { status?: string }) => row.status === 'sold_out')
    );
    expect(soldOutCall).toBeDefined();
    const soldOutRows = soldOutCall![0].data as Array<{ flightId: string; status: string; travelDate: Date }>;
    const soldOutDates = soldOutRows.map((r) => r.travelDate.toISOString().slice(0, 10));
    expect(soldOutDates).toContain('2026-11-07');
    expect(soldOutDates).not.toContain('2026-11-05');
  });
});

describe('runScrapeForQuery extraction failure surfacing (issue #65)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.query.findUnique.mockResolvedValue(BASE_QUERY);
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
  });

  it('logs to console.error inside the chain walk when an aggregator throws (silent-catch fix)', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockNavigateGoogleFlights.mockRejectedValue(new Error('browser crashed'));

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('failed');
    // After the aggregator chain refactor, individual source throws are caught
    // inside the chain loop so the next aggregator can still be tried. The
    // failure surfaces here, not as a bubbled pair-level throw.
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringMatching(/aggregator=google_flights threw err=.*browser crashed/),
    );
    consoleErr.mockRestore();
  });

  it('logs to console.error in the outer runScrapeForQuery catch when scrapeQueryForCountry itself throws', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15',
        price: 350,
        currency: 'USD',
        airline: 'Delta',
        bookingUrl: '',
        stops: 0,
        duration: '5h',
        departureTime: null,
        arrivalTime: null,
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    // priceSnapshot.findMany runs after the pair loop inside
    // scrapeQueryForCountry, so its throw lands in the outer catch.
    mockPrisma.priceSnapshot.findMany.mockRejectedValueOnce(new Error('db connection lost'));

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('db connection lost');
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('runScrapeForQuery failed'),
    );
    consoleErr.mockRestore();
  });

  it('continues with remaining pairs when a single pair throws (issue #65 audit)', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      tripType: 'one_way',
      dateFrom: new Date('2026-11-07'),
      dateTo: new Date('2026-11-09'),
      flexibility: 1,
    });
    // First pair throws, second succeeds, third succeeds.
    mockNavigateGoogleFlights
      .mockRejectedValueOnce(new Error('browser crashed'))
      .mockResolvedValue({
        html: '<html>flights</html>',
        url: 'https://flights.google.com',
        resultsFound: true,
        source: 'google_flights',
      });
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-11-08',
        price: 350,
        currency: 'USD',
        airline: 'Delta',
        bookingUrl: '',
        stops: 0,
        duration: '5h',
        departureTime: null,
        arrivalTime: null,
        seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    // Chain-walk catch logs the per-aggregator throw rather than letting the
    // pair bubble up; subsequent pairs still run because the chain returns
    // normally with empty prices.
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringMatching(/aggregator=google_flights threw err=.*browser crashed/),
    );
    consoleErr.mockRestore();
  });

  it('retries when first attempt returns llm_error then succeeds', async () => {
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
    mockExtractPrices
      .mockResolvedValueOnce({
        prices: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        failureReason: 'llm_error',
      })
      .mockResolvedValueOnce({
        prices: [{
          travelDate: '2026-06-15',
          price: 350,
          currency: 'USD',
          airline: 'Delta',
          bookingUrl: '',
          stops: 0,
          duration: '5h',
          departureTime: null,
          arrivalTime: null,
          seatsLeft: null,
        }],
        usage: { inputTokens: 100, outputTokens: 20 },
      });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(mockExtractPrices).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('retries when first attempt returns json_parse_error then succeeds', async () => {
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
    mockExtractPrices
      .mockResolvedValueOnce({
        prices: [],
        usage: { inputTokens: 100, outputTokens: 20 },
        failureReason: 'json_parse_error',
      })
      .mockResolvedValueOnce({
        prices: [{
          travelDate: '2026-06-15',
          price: 350,
          currency: 'USD',
          airline: 'Delta',
          bookingUrl: '',
          stops: 0,
          duration: '5h',
          departureTime: null,
          arrivalTime: null,
          seatsLeft: null,
        }],
        usage: { inputTokens: 100, outputTokens: 20 },
      });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(mockExtractPrices).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('writes human-readable llm_error message to FetchRun', async () => {
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html>flights</html>',
      url: 'https://flights.google.com',
      resultsFound: true,
      source: 'google_flights',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      failureReason: 'llm_error',
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('LLM call failed');
  }, 15_000);
});

describe('runScrapeForQuery airline_direct -> google_flights diversification (issue #65)', () => {
  const TURKISH_QUERY = {
    ...BASE_QUERY,
    origin: 'BRI',
    destination: 'JFK',
    dateFrom: new Date('2026-11-07'),
    dateTo: new Date('2026-11-07'),
    tripType: 'one_way',
    preferredAirlines: ['Turkish Airlines'],
    currency: 'EUR',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsKnownAirline.mockReturnValue(true);
    mockPrisma.query.findUnique.mockResolvedValue(TURKISH_QUERY);
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
    mockNavigateAirlineDirect.mockResolvedValue({
      html: '<stub-page-1964-chars>',
      url: 'https://www.turkishairlines.com/en-us/flights/?origin=BRI&destination=JFK',
      resultsFound: true,
      source: 'airline_direct',
    });
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<google-results>',
      url: 'https://www.google.com/travel/flights?q=BRI+to+JFK',
      resultsFound: true,
      source: 'google_flights',
    });
  });

  // T3: the headline issue 65 fix. Turkish stub passes navigation but yields 0
  // prices on extraction. Same attempt now tries Google Flights and succeeds.
  it('falls back to Google Flights when airline_direct extracts empty_extraction', async () => {
    mockExtractPrices
      .mockResolvedValueOnce({
        prices: [],
        usage: { inputTokens: 100, outputTokens: 0 },
        failureReason: 'empty_extraction',
      })
      .mockResolvedValueOnce({
        prices: [{
          travelDate: '2026-11-07',
          price: 431,
          currency: 'EUR',
          airline: 'Turkish Airlines',
          bookingUrl: 'https://google.com/booking',
          stops: 1,
          duration: '12h 30m',
          departureTime: '10:25 AM',
          arrivalTime: '2:55 PM',
          seatsLeft: null,
        }],
        usage: { inputTokens: 200, outputTokens: 50 },
      });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(result.snapshotsCount).toBe(1);
    expect(mockNavigateAirlineDirect).toHaveBeenCalledTimes(1);
    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(mockExtractPrices).toHaveBeenCalledTimes(2);

    // FetchRun.source records the composite label so operators can grep for
    // diversification events without a schema migration.
    const fetchRunUpdate = mockPrisma.fetchRun.update.mock.calls[0]![0] as { data: { source: string } };
    expect(fetchRunUpdate.data.source).toContain('airline_direct');
    expect(fetchRunUpdate.data.source).toContain('google_flights');
  });

  // T4: real flights existed but the LLM correctly filtered them out per the
  // user-supplied maxStops/maxPrice. That is a true signal, not a stub-page
  // failure: diversification must NOT fire (no Google Flights navigation).
  // The outer attempt loop still iterates on non-retryable reasons (the
  // RETRYABLE_FAILURES gate only suppresses the inter-attempt delay), so the
  // airline-direct call count is incidental — the diversification check is
  // strictly: did we trigger a Google Flights navigation?
  it('does NOT diversify when airline_direct returns all_filtered_out', async () => {
    mockExtractPrices.mockResolvedValue({
      prices: [],
      usage: { inputTokens: 100, outputTokens: 10 },
      failureReason: 'all_filtered_out',
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('failed');
    expect(mockNavigateGoogleFlights).not.toHaveBeenCalled();
  });

  // T5: a user typing "only Lufthansa flights from FRA to JFK" still gets the
  // airline filter applied on the Google fallback extraction. Removing the
  // auto-derive in Phase 1 was about the IMPLICIT case; explicit user intent
  // must survive.
  it('preserves explicit preferredAirlines on the Google fallback extractPrices call', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...TURKISH_QUERY,
      preferredAirlines: ['Lufthansa'],
    });
    mockExtractPrices
      .mockResolvedValueOnce({
        prices: [],
        usage: { inputTokens: 100, outputTokens: 0 },
        failureReason: 'empty_extraction',
      })
      .mockResolvedValueOnce({
        prices: [{
          travelDate: '2026-11-07',
          price: 522,
          currency: 'EUR',
          airline: 'Lufthansa',
          bookingUrl: 'https://google.com/booking',
          stops: 1,
          duration: '11h 45m',
          departureTime: '8:00 AM',
          arrivalTime: '12:45 PM',
          seatsLeft: null,
        }],
        usage: { inputTokens: 200, outputTokens: 50 },
      });

    await runScrapeForQuery('q1');

    // 4th positional argument to extractPrices is the QueryFilters object
    const googleExtractCall = mockExtractPrices.mock.calls[1];
    expect(googleExtractCall).toBeDefined();
    const filtersArg = googleExtractCall![3] as { preferredAirlines: string[] };
    expect(filtersArg.preferredAirlines).toEqual(['Lufthansa']);
  });
});

describe('PriceSnapshot schema', () => {
  it('bookingUrl must be optional (String?) to accept LLM null values', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../../prisma/schema.prisma'),
      'utf-8'
    );
    const match = schema.match(/model PriceSnapshot\s*\{[\s\S]*?\}/);
    expect(match).not.toBeNull();
    const model = match![0];
    expect(model).toMatch(/bookingUrl\s+String\?/);
  });
});

import { resolveAggregatorChain } from './run-scrape';

describe('resolveAggregatorChain', () => {
  const ALL_ENABLED = ['google_flights', 'airline_direct', 'skyscanner', 'kayak'];
  const DEFAULT_ENABLED = ['google_flights', 'airline_direct'];

  it('returns google_flights only when no prefs and default admin allowlist', () => {
    expect(resolveAggregatorChain([], [], DEFAULT_ENABLED)).toEqual(['google_flights']);
  });

  it('falls back to admin allowlist order when query and user prefs are empty', () => {
    expect(resolveAggregatorChain([], [], ALL_ENABLED)).toEqual(['google_flights', 'skyscanner', 'kayak']);
  });

  it('uses user prefs when query prefs are empty', () => {
    expect(resolveAggregatorChain([], ['kayak', 'google_flights'], ALL_ENABLED)).toEqual(['kayak', 'google_flights']);
  });

  it('per-query prefs override per-user prefs', () => {
    const chain = resolveAggregatorChain(['skyscanner'], ['kayak', 'google_flights'], ALL_ENABLED);
    expect(chain).toEqual(['skyscanner', 'google_flights']);
  });

  it('filters out aggregators not allowed by admin', () => {
    const chain = resolveAggregatorChain(['skyscanner', 'kayak'], [], DEFAULT_ENABLED);
    expect(chain).toEqual(['google_flights']);
  });

  it('drops airline_direct from the chain (handled separately)', () => {
    const chain = resolveAggregatorChain(['airline_direct', 'skyscanner'], [], ALL_ENABLED);
    expect(chain).toEqual(['skyscanner', 'google_flights']);
  });

  it('dedupes when google_flights is already in user prefs', () => {
    const chain = resolveAggregatorChain([], ['google_flights', 'skyscanner', 'google_flights'], ALL_ENABLED);
    expect(chain).toEqual(['google_flights', 'skyscanner']);
  });

  it('forces google_flights as terminal fallback when only kayak is requested', () => {
    expect(resolveAggregatorChain(['kayak'], [], ALL_ENABLED)).toEqual(['kayak', 'google_flights']);
  });

  it('does NOT append google_flights when admin disabled it', () => {
    const chain = resolveAggregatorChain(['skyscanner'], [], ['skyscanner', 'kayak']);
    expect(chain).toEqual(['skyscanner']);
  });

  it('forces google_flights when admin misconfigured everything off', () => {
    const chain = resolveAggregatorChain([], [], []);
    expect(chain).toEqual(['google_flights']);
  });

  it('ignores unknown strings in any source', () => {
    const chain = resolveAggregatorChain(['expedia', 'skyscanner'], [], ALL_ENABLED);
    expect(chain).toEqual(['skyscanner', 'google_flights']);
  });
});

describe('runScrapeForQuery aggregator chain walk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsKnownAirline.mockReturnValue(false);
    mockPrisma.query.findUnique.mockResolvedValue(BASE_QUERY);
    mockPrisma.fetchRun.create.mockResolvedValue({ id: 'run1' });
    mockPrisma.fetchRun.update.mockResolvedValue({});
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
    });
    mockPrisma.priceSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.priceSnapshot.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.apiUsageLog.create.mockResolvedValue({});
  });

  it('walks google_flights for a no-airline-pref query with default admin allowlist', async () => {
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html/>', url: 'https://g', resultsFound: true, source: 'google_flights',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15', price: 350, currency: 'USD', airline: 'Delta',
        bookingUrl: 'https://g', stops: 0, duration: '5h',
        departureTime: null, arrivalTime: null, seatsLeft: null,
      }],
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(mockNavigateSkyscanner).not.toHaveBeenCalled();
    expect(mockNavigateKayak).not.toHaveBeenCalled();
  });

  it('falls through to skyscanner when google_flights returns empty extraction', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      user: { preferredAggregators: ['google_flights', 'skyscanner'] },
    });
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
      aggregatorsEnabled: ['google_flights', 'skyscanner'],
    });
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html/>', url: 'https://g', resultsFound: true, source: 'google_flights',
    });
    mockNavigateSkyscanner.mockResolvedValue({
      html: '<html/>', url: 'https://s', resultsFound: true, source: 'skyscanner',
    });
    mockExtractPrices
      .mockResolvedValueOnce({
        prices: [],
        usage: { inputTokens: 100, outputTokens: 20 },
        failureReason: 'empty_extraction',
      })
      .mockResolvedValueOnce({
        prices: [{
          travelDate: '2026-06-15', price: 290, currency: 'USD', airline: 'JetBlue',
          bookingUrl: 'https://s', stops: 0, duration: '5h',
          departureTime: null, arrivalTime: null, seatsLeft: null,
        }],
        usage: { inputTokens: 110, outputTokens: 25 },
      });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(result.snapshotsCount).toBe(1);
    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(mockNavigateSkyscanner).toHaveBeenCalledTimes(1);
  });

  it('short-circuits the chain on all_filtered_out (does not call skyscanner)', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      user: { preferredAggregators: ['google_flights', 'skyscanner'] },
    });
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
      aggregatorsEnabled: ['google_flights', 'skyscanner'],
    });
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html/>', url: 'https://g', resultsFound: true, source: 'google_flights',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [],
      usage: { inputTokens: 100, outputTokens: 20 },
      failureReason: 'all_filtered_out',
    });

    await runScrapeForQuery('q1');

    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(2); // two extract attempts
    expect(mockNavigateSkyscanner).not.toHaveBeenCalled();
    expect(mockNavigateKayak).not.toHaveBeenCalled();
  });

  it('admin disabled skyscanner -> user pref [skyscanner, kayak] resolves to [kayak]', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      user: { preferredAggregators: ['skyscanner', 'kayak'] },
    });
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
      aggregatorsEnabled: ['google_flights', 'kayak'],
    });
    mockNavigateKayak.mockResolvedValue({
      html: '<html/>', url: 'https://k', resultsFound: true, source: 'kayak',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15', price: 310, currency: 'USD', airline: 'Spirit',
        bookingUrl: 'https://k', stops: 0, duration: '5h',
        departureTime: null, arrivalTime: null, seatsLeft: null,
      }],
      usage: { inputTokens: 90, outputTokens: 20 },
    });

    const result = await runScrapeForQuery('q1');

    expect(result.status).toBe('success');
    expect(mockNavigateKayak).toHaveBeenCalledTimes(1);
    expect(mockNavigateSkyscanner).not.toHaveBeenCalled();
  });

  it('per-query prefs override per-user prefs in the resolved chain', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      preferredAggregators: ['skyscanner'],
      user: { preferredAggregators: ['kayak', 'google_flights'] },
    });
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
      aggregatorsEnabled: ['google_flights', 'skyscanner', 'kayak'],
    });
    mockNavigateSkyscanner.mockResolvedValue({
      html: '<html/>', url: 'https://s', resultsFound: true, source: 'skyscanner',
    });
    mockExtractPrices.mockResolvedValue({
      prices: [{
        travelDate: '2026-06-15', price: 280, currency: 'USD', airline: 'British Airways',
        bookingUrl: 'https://s', stops: 0, duration: '5h',
        departureTime: null, arrivalTime: null, seatsLeft: null,
      }],
      usage: { inputTokens: 95, outputTokens: 22 },
    });

    await runScrapeForQuery('q1');

    expect(mockNavigateSkyscanner).toHaveBeenCalledTimes(1);
    expect(mockNavigateKayak).not.toHaveBeenCalled();
  });

  it('anonymous query (user null) falls back to admin allowlist order', async () => {
    mockPrisma.query.findUnique.mockResolvedValue({
      ...BASE_QUERY,
      user: null,
    });
    mockPrisma.extractionConfig.findFirst.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      scrapeInterval: 3,
      defaultCurrency: null,
      defaultCountry: null,
      vpnProvider: null,
      vpnCountries: [],
      aggregatorsEnabled: ['google_flights', 'kayak'],
    });
    // google_flights returns empty -> chain walks kayak
    mockNavigateGoogleFlights.mockResolvedValue({
      html: '<html/>', url: 'https://g', resultsFound: true, source: 'google_flights',
    });
    mockNavigateKayak.mockResolvedValue({
      html: '<html/>', url: 'https://k', resultsFound: true, source: 'kayak',
    });
    mockExtractPrices
      .mockResolvedValueOnce({
        prices: [], usage: { inputTokens: 80, outputTokens: 10 }, failureReason: 'empty_extraction',
      })
      .mockResolvedValueOnce({
        prices: [{
          travelDate: '2026-06-15', price: 415, currency: 'USD', airline: 'Frontier',
          bookingUrl: 'https://k', stops: 0, duration: '5h',
          departureTime: null, arrivalTime: null, seatsLeft: null,
        }],
        usage: { inputTokens: 100, outputTokens: 18 },
      });

    const result = await runScrapeForQuery('q1');
    expect(result.status).toBe('success');
    expect(mockNavigateGoogleFlights).toHaveBeenCalledTimes(1);
    expect(mockNavigateKayak).toHaveBeenCalledTimes(1);
  });
});
