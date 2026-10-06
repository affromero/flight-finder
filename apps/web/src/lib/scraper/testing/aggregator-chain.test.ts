import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPrisma, mockNavigateGoogleFlights, mockNavigateSkyscanner, mockNavigateKayak, mockExtractPrices, runScrapeForQuery, BASE_QUERY } from './run-scrape-fixture';
import { resolveAggregatorChain } from '../run-scrape';

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
