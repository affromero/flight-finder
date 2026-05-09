import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExtract } = vi.hoisted(() => ({
  mockExtract: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findFirst: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      }),
    },
  },
}));

vi.mock('./ai-registry', () => ({
  EXTRACTION_PROVIDERS: {
    anthropic: {
      displayName: 'Anthropic',
      envKey: 'ANTHROPIC_API_KEY',
      models: [],
      extract: mockExtract,
    },
  },
  CLI_PROVIDERS: {},
  LOCAL_PROVIDERS: new Set(),
}));

process.env.ANTHROPIC_API_KEY = 'test-key';

import { extractPrices } from './extract-prices';

describe('extractPrices', () => {
  beforeEach(() => {
    mockExtract.mockReset();
  });

  it('returns page_not_loaded when resultsFound is false', async () => {
    const result = await extractPrices(
      '<html>loading...</html>',
      'https://flights.google.com',
      '2026-06-15',
      { maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
      10,
      false,
    );
    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('page_not_loaded');
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('extracts valid prices from llm json array', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 623, currency: 'USD', airline: 'Delta', bookingUrl: 'https://delta.com', stops: 0, duration: '5h 30m', departureTime: '10:25 AM', arrivalTime: '3:55 PM', seatsLeft: 3 },
        { travelDate: '2026-06-15', price: 450, currency: 'USD', airline: 'United', bookingUrl: 'https://united.com', stops: 1, duration: '8h 10m', departureTime: '2:00 PM', arrivalTime: '10:10 PM', seatsLeft: null },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const result = await extractPrices(
      'Flights: Delta $623, United $450',
      'https://flights.google.com',
      '2026-06-15',
    );
    expect(result.prices).toHaveLength(2);
    expect(result.prices[0]!.airline).toBe('Delta');
    expect(result.failureReason).toBeUndefined();
  });

  it('filters out entries with zero price', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 0, currency: 'USD', airline: 'Delta', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
        { travelDate: '2026-06-15', price: 300, currency: 'USD', airline: 'United', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
      ]),
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.prices).toHaveLength(1);
    expect(result.prices[0]!.airline).toBe('United');
  });

  it('filters out entries with empty airline', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 300, currency: 'USD', airline: '', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
      ]),
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('all_filtered_out');
  });

  it('coerces null bookingUrl to empty string', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 400, currency: 'USD', airline: 'easyJet', bookingUrl: null, stops: 0, duration: '1h 45m', departureTime: '8:00 AM', arrivalTime: '9:45 AM', seatsLeft: null },
        { travelDate: '2026-06-15', price: 350, currency: 'USD', airline: 'KLM', stops: 1, duration: '3h', departureTime: '10:00 AM', arrivalTime: '1:00 PM', seatsLeft: null },
      ]),
      usage: { inputTokens: 300, outputTokens: 80 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.prices).toHaveLength(2);
    expect(result.prices[0]!.bookingUrl).toBe('');
    expect(result.prices[1]!.bookingUrl).toBe('');
  });

  it('returns all_filtered_out when all entries invalid', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 0, currency: 'USD', airline: 'X', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
        { travelDate: '2026-06-15', price: -5, currency: 'USD', airline: 'Y', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
      ]),
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.failureReason).toBe('all_filtered_out');
  });

  it('returns empty_extraction when llm returns empty array', async () => {
    mockExtract.mockResolvedValue({
      content: '[]',
      usage: { inputTokens: 200, outputTokens: 10 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('empty_extraction');
  });

  it('coerces null bookingUrl to empty string instead of passing null through', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 350, currency: 'USD', airline: 'Delta', bookingUrl: null, stops: 0, duration: '5h', departureTime: null, arrivalTime: null, seatsLeft: null },
      ]),
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.prices).toHaveLength(1);
    expect(result.prices[0]!.bookingUrl).toBe('');
    expect(result.failureReason).toBeUndefined();
  });

  it('returns no_json_in_response when llm returns no array', async () => {
    mockExtract.mockResolvedValue({
      content: 'I could not find any flights on this page.',
      usage: { inputTokens: 200, outputTokens: 20 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');
    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('no_json_in_response');
  });

  it('includes currency detection instruction when currency is null', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 500, currency: 'GBP', airline: 'BA', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    await extractPrices('page content', 'https://flights.google.com', '2026-06-15',
      { maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
      10, true, 'google_flights', null
    );

    const systemPrompt = mockExtract.mock.calls[0]![2] as string;
    expect(systemPrompt).toContain('Detect the currency from the page content');
  });

  it('uses explicit currency in prompt when provided', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 500, currency: 'EUR', airline: 'LH', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    await extractPrices('page content', 'https://flights.google.com', '2026-06-15',
      { maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
      10, true, 'google_flights', 'EUR'
    );

    const systemPrompt = mockExtract.mock.calls[0]![2] as string;
    expect(systemPrompt).toContain('Use "EUR" as the currency code');
    expect(systemPrompt).not.toContain('Detect the currency');
  });

  it('throws when provider is unknown', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findFirst).mockResolvedValueOnce({
      provider: 'nonexistent',
      model: 'x',
    } as never);

    await expect(
      extractPrices('content', 'https://example.com', '2026-06-15')
    ).rejects.toThrow('Unknown extraction provider');
  });

  it('filters out flights exceeding maxDurationHours', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 500, currency: 'USD', airline: 'Delta', bookingUrl: '', stops: 0, duration: '11h 20m', departureTime: '10:00 AM', arrivalTime: '9:20 PM', seatsLeft: null, flightNumber: 'DL 1' },
        { travelDate: '2026-06-15', price: 600, currency: 'USD', airline: 'United', bookingUrl: '', stops: 1, duration: '21h 30m', departureTime: '8:00 AM', arrivalTime: '5:30 AM', seatsLeft: null, flightNumber: 'UA 2' },
        { travelDate: '2026-06-15', price: 450, currency: 'USD', airline: 'Alaska', bookingUrl: '', stops: 0, duration: '8h', departureTime: '6:00 AM', arrivalTime: '2:00 PM', seatsLeft: null, flightNumber: 'AS 3' },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const result = await extractPrices(
      'page', 'https://flights.google.com', '2026-06-15',
      { maxPrice: null, maxStops: null, maxDurationHours: 12, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
    );
    expect(result.prices).toHaveLength(2);
    expect(result.prices.map((p) => p.flightNumber).sort()).toEqual(['AS 3', 'DL 1']);
  });

  it('returns all_filtered_out when duration filter empties an otherwise valid result', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 500, currency: 'USD', airline: 'Delta', bookingUrl: '', stops: 0, duration: '15h', departureTime: null, arrivalTime: null, seatsLeft: null, flightNumber: 'DL 1' },
        { travelDate: '2026-06-15', price: 600, currency: 'USD', airline: 'United', bookingUrl: '', stops: 1, duration: '20h', departureTime: null, arrivalTime: null, seatsLeft: null, flightNumber: 'UA 2' },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const result = await extractPrices(
      'page', 'https://flights.google.com', '2026-06-15',
      { maxPrice: null, maxStops: null, maxDurationHours: 10, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
    );
    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('all_filtered_out');
  });

  it('keeps flights with unparseable duration when maxDurationHours is set', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 500, currency: 'USD', airline: 'Delta', bookingUrl: '', stops: 0, duration: null, departureTime: null, arrivalTime: null, seatsLeft: null, flightNumber: 'DL 1' },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const result = await extractPrices(
      'page', 'https://flights.google.com', '2026-06-15',
      { maxPrice: null, maxStops: null, maxDurationHours: 10, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
    );
    expect(result.prices).toHaveLength(1);
  });

  it('propagates flightNumber from llm output', async () => {
    mockExtract.mockResolvedValue({
      content: JSON.stringify([
        { travelDate: '2026-06-15', price: 623, currency: 'USD', airline: 'Delta', bookingUrl: 'https://delta.com', stops: 0, duration: '5h 30m', departureTime: '10:25 AM', arrivalTime: '3:55 PM', seatsLeft: 3, flightNumber: 'DL 345' },
        { travelDate: '2026-06-15', price: 450, currency: 'USD', airline: 'Delta', bookingUrl: 'https://delta.com', stops: 0, duration: '5h 30m', departureTime: '10:25 AM', arrivalTime: '3:55 PM', seatsLeft: 5, flightNumber: 'DL 901' },
      ]),
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const result = await extractPrices(
      'Flights: Delta DL 345 $623, Delta DL 901 $450',
      'https://flights.google.com',
      '2026-06-15',
    );
    expect(result.prices).toHaveLength(2);
    expect(result.prices[0]!.flightNumber).toBe('DL 345');
    expect(result.prices[1]!.flightNumber).toBe('DL 901');
  });

  it('throws when api key is missing', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await expect(
        extractPrices('content', 'https://example.com', '2026-06-15')
      ).rejects.toThrow('Missing API key');
    } finally {
      process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  // Issue #65: previously, if the LLM rejected (timeout, rate limit, etc.)
  // the error propagated up and was swallowed by runScrapeForQuery's silent
  // catch. Now extractPrices returns a structured llm_error and logs.
  it('returns llm_error when provider extract throws', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExtract.mockRejectedValue(new Error('rate limited'));

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');

    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('llm_error');
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('FAIL llm_error'),
    );
    consoleErr.mockRestore();
  });

  it('returns llm_error when provider extract is aborted by AbortSignal timeout', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abortErr = new Error('Request was aborted');
    abortErr.name = 'AbortError';
    mockExtract.mockRejectedValue(abortErr);

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');

    expect(result.failureReason).toBe('llm_error');
    consoleErr.mockRestore();
  });

  it('returns json_parse_error when LLM output has malformed JSON inside the bracket match', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The regex /\[[\s\S]*\]/ matches; JSON.parse fails on truncated content.
    mockExtract.mockResolvedValue({
      content: '[{ "travelDate": "2026-06-15", "price": 6',  // truncated; closing ] is missing
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    // Force the regex to match by giving it a closing bracket that breaks JSON.
    mockExtract.mockResolvedValue({
      content: '[{ "travelDate": "2026-06-15", "price": invalid }]',
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const result = await extractPrices('page content', 'https://flights.google.com', '2026-06-15');

    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBe('json_parse_error');
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining('FAIL json_parse_error'),
    );
    consoleErr.mockRestore();
  });
});
