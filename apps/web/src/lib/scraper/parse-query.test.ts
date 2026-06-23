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

// Keep the real ai-registry (so resolveApiKey is exercised end to end), but
// swap the provider extract fns for a spy.
vi.mock('./ai-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-registry')>();
  return {
    ...actual,
    EXTRACTION_PROVIDERS: {
      anthropic: {
        displayName: 'Anthropic',
        envKey: 'ANTHROPIC_API_KEY',
        models: [],
        extract: mockExtract,
      },
      ollama: {
        displayName: 'Ollama',
        envKey: undefined,
        allowCustomModel: true,
        allowCustomBaseUrl: true,
        models: [],
        extract: mockExtract,
      },
    },
    CLI_PROVIDERS: {},
    LOCAL_PROVIDERS: new Set(['ollama']),
  };
});

// Provide a fake API key so the provider check passes
process.env.ANTHROPIC_API_KEY = 'test-key';

import { parseFlightQuery } from './parse-query';

function makeLlmResponse(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

describe('parseFlightQuery', () => {
  beforeEach(() => {
    mockExtract.mockReset();
  });

  it('parses high-confidence query with envelope format', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'New York JFK' }],
          destinations: [{ code: 'LAX', name: 'Los Angeles' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX June 15-22');
    expect(response.confidence).toBe('high');
    expect(response.parsed?.origin).toBe('JFK');
    expect(response.parsed?.destination).toBe('LAX');
    expect(response.parsed?.origins).toHaveLength(1);
  });

  it('normalizes legacy flat format to arrays', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        origin: 'ORD',
        originName: 'Chicago',
        destination: 'MIA',
        destinationName: 'Miami',
        dateFrom: '2026-07-01',
        dateTo: '2026-07-10',
        flexibility: 0,
        maxPrice: null,
        maxStops: null,
        preferredAirlines: [],
        timePreference: 'any',
        cabinClass: 'economy',
        tripType: 'round_trip',
        currency: 'USD',
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('Chicago to Miami July');
    expect(response.parsed?.origins).toEqual([{ code: 'ORD', name: 'Chicago' }]);
    expect(response.parsed?.destinations).toEqual([{ code: 'MIA', name: 'Miami' }]);
    expect(response.confidence).toBe('high');
  });

  it('derives dateFrom and dateTo from outboundDates and returnDates', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'SFO', name: 'San Francisco' }],
          destinations: [{ code: 'SEA', name: 'Seattle' }],
          dateFrom: '2026-06-10',
          dateTo: '2026-06-20',
          outboundDates: ['2026-06-15', '2026-06-16'],
          returnDates: ['2026-06-22', '2026-06-23'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('SFO to SEA June 15 or 16, return 22 or 23');
    expect(response.parsed?.dateFrom).toBe('2026-06-15');
    expect(response.parsed?.dateTo).toBe('2026-06-23');
  });

  it('caps outboundDates at six entries', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LHR', name: 'London' }],
          dateFrom: '2026-06-01',
          dateTo: '2026-06-30',
          outboundDates: ['2026-06-01', '2026-06-05', '2026-06-10', '2026-06-15', '2026-06-20', '2026-06-25', '2026-06-28', '2026-06-30'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'one_way',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to London any June date');
    expect(response.parsed?.outboundDates).toHaveLength(6);
  });

  it('filters invalid date strings from outboundDates', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'CDG', name: 'Paris' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-20',
          outboundDates: ['2026-06-15', 'garbage', '2026-06-20', 'not-a-date'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'one_way',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to Paris');
    expect(response.parsed?.outboundDates).toEqual(['2026-06-15', '2026-06-20']);
  });

  it('returns null parsed when missing origins', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [],
          destinations: [{ code: 'LAX', name: 'LA' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'one_way',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('somewhere to LA');
    expect(response.parsed).toBeNull();
    expect(response.confidence).toBe('low');
    expect(response.ambiguities.length).toBeGreaterThan(0);
  });

  it('downgrades high confidence to medium for 14+ day span', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-01',
          dateTo: '2026-06-30',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX in June');
    expect(response.confidence).toBe('medium');
    expect(response.dateSpanDays).toBe(29);
    expect(response.ambiguities.some((a) => a.field === 'date')).toBe(true);
  });

  it('computes dateSpanDays correctly', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX June 15-22');
    expect(response.dateSpanDays).toBe(7);
  });

  it('defaults currency to null when not specified', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX');
    expect(response.parsed?.currency).toBeNull();
  });

  it('extracts maxDurationHours when phrased as "duration under N hours"', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'LAX', name: 'Los Angeles' }],
          destinations: [{ code: 'IST', name: 'Istanbul' }],
          dateFrom: '2026-05-20',
          dateTo: '2026-05-30',
          flexibility: 0,
          maxPrice: 1000,
          maxStops: null,
          maxDurationHours: 20,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 120, outputTokens: 60 },
    });

    const { response } = await parseFlightQuery('LAX to IST 5/20 to 5/30 with duration under 20 hours and price under $1000');
    expect(response.parsed?.maxDurationHours).toBe(20);
    expect(response.parsed?.maxPrice).toBe(1000);
  });

  it('returns null maxDurationHours when not mentioned', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'New York JFK' }],
          destinations: [{ code: 'LAX', name: 'Los Angeles' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: null,
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX June 15-22');
    expect(response.parsed?.maxDurationHours).toBeNull();
  });

  it('throws when llm returns no JSON', async () => {
    mockExtract.mockResolvedValue({
      content: 'Sorry, I cannot parse that query.',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    await expect(parseFlightQuery('asdfghjkl')).rejects.toThrow('Failed to parse LLM response as JSON');
  });

  it('logs a preview of the raw LLM content when no JSON block is found (issue #84)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExtract.mockResolvedValue({
      content: 'I am sorry, I cannot help with that request.',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    await expect(parseFlightQuery('asdfghjkl')).rejects.toThrow('Failed to parse LLM response as JSON');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('FAIL no_json_in_response'),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('preview=I am sorry'),
    );
    spy.mockRestore();
  });

  it('logs a preview when JSON parse fails on a malformed block (issue #84)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Regex finds { ... } but the contents are not valid JSON (unquoted keys).
    mockExtract.mockResolvedValue({
      content: 'Here is the result: { foo: bar } and more',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    await expect(parseFlightQuery('asdfghjkl')).rejects.toThrow('Failed to parse LLM response as JSON');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('FAIL json_parse_error'),
    );
    spy.mockRestore();
  });

  it('opts into responseFormat json_object for local providers (issue #84)', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findFirst).mockResolvedValueOnce({
      provider: 'ollama',
      model: 'llama3.1:8b',
    } as never);

    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await parseFlightQuery('JFK to LAX June 15-22');

    expect(mockExtract).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ responseFormat: 'json_object' }),
    );
  });

  it('does not set responseFormat outside local providers (issue #84)', async () => {
    // Default mocked provider is anthropic; LOCAL_PROVIDERS excludes it, so
    // the OpenAI compat `response_format` flag is not safe to force and must
    // not appear in the extract call. Same guard protects custom
    // OPENAI_BASE_URL endpoints from a 400 on unsupported models.
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await parseFlightQuery('JFK to LAX June 15-22');

    const callArgs = mockExtract.mock.calls[0]![4] as Record<string, unknown> | undefined;
    expect(callArgs).not.toHaveProperty('responseFormat');
  });

  it('passes timeoutMs to extract when config.extractTimeoutSeconds is set (issue #86)', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findFirst).mockResolvedValueOnce({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      extractTimeoutSeconds: 240,
    } as never);

    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await parseFlightQuery('JFK to LAX June 15-22');

    expect(mockExtract).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ timeoutMs: 240_000 }),
    );
  });

  it('omits timeoutMs when config.extractTimeoutSeconds is unset (issue #86)', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await parseFlightQuery('JFK to LAX June 15-22');

    const callArgs = mockExtract.mock.calls[0]![4] as Record<string, unknown> | undefined;
    expect(callArgs).not.toHaveProperty('timeoutMs');
  });

  it('throws when provider is unknown', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findFirst).mockResolvedValueOnce({
      provider: 'nonexistent',
      model: 'x',
    } as never);

    await expect(parseFlightQuery('JFK to LAX')).rejects.toThrow('Unknown extraction provider');
  });

  it('keeps round-trip with two pinned legs at high confidence even when trip spans 21 days', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-03-01',
          dateTo: '2026-03-22',
          outboundDates: ['2026-03-01'],
          returnDates: ['2026-03-22'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX March 1, return March 22');
    expect(response.confidence).toBe('high');
    expect(response.dateSpanDays).toBe(21);
    expect(response.ambiguities).toEqual([]);
  });

  it('downgrades round-trip with wide outbound window and names the outbound leg', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-03-01',
          dateTo: '2026-03-25',
          outboundDates: ['2026-03-01', '2026-03-11'],
          returnDates: ['2026-03-25'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX March 1-11 out, March 25 return');
    expect(response.confidence).toBe('medium');
    const outboundAmbiguity = response.ambiguities.find((a) => /outbound/i.test(a.question));
    expect(outboundAmbiguity).toBeDefined();
    expect(response.ambiguities.find((a) => /return/i.test(a.question))).toBeUndefined();
  });

  it('downgrades round-trip with wide return window and names the return leg', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-03-01',
          dateTo: '2026-03-25',
          outboundDates: ['2026-03-01'],
          returnDates: ['2026-03-15', '2026-03-27'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX March 1, return March 15-27');
    expect(response.confidence).toBe('medium');
    const returnAmbiguity = response.ambiguities.find((a) => /return/i.test(a.question));
    expect(returnAmbiguity).toBeDefined();
    expect(response.ambiguities.find((a) => /outbound/i.test(a.question))).toBeUndefined();
  });

  it('caps each leg at 4 dates when both legs are ranges', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-03-01',
          dateTo: '2026-03-25',
          outboundDates: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'],
          returnDates: ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24', '2026-03-25'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX March 1-6 out, March 20-25 return');
    expect(response.parsed?.outboundDates).toHaveLength(4);
    expect(response.parsed?.returnDates).toHaveLength(4);
  });

  it('keeps 6-date cap when only one leg is a range', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-03-01',
          dateTo: '2026-03-25',
          outboundDates: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07'],
          returnDates: ['2026-03-25'],
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const { response } = await parseFlightQuery('JFK to LAX any of first week, return March 25');
    expect(response.parsed?.outboundDates).toHaveLength(6);
    expect(response.parsed?.returnDates).toHaveLength(1);
  });

  it('caps conversation history sent to the LLM at the most recent 6 turns', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const longHistory = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn-${i}`,
    }));

    await parseFlightQuery('latest answer', longHistory);

    const promptArg = mockExtract.mock.calls[0]?.[3] as string;
    expect(promptArg).toContain('turn-11');
    expect(promptArg).toContain('turn-6');
    expect(promptArg).not.toContain('turn-5');
    expect(promptArg).not.toContain('turn-0');
    expect(promptArg.endsWith('User: latest answer')).toBe(true);
  });

  it('truncates oversized conversation history entry content to 2000 chars', async () => {
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'JFK' }],
          destinations: [{ code: 'LAX', name: 'LAX' }],
          dateFrom: '2026-06-15',
          dateTo: '2026-06-22',
          flexibility: 0,
          maxPrice: null,
          maxStops: null,
          preferredAirlines: [],
          timePreference: 'any',
          cabinClass: 'economy',
          tripType: 'round_trip',
          currency: 'USD',
        },
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // One entry with content well over 2000 chars
    const oversizedContent = 'x'.repeat(5000);
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: oversizedContent },
    ];

    await parseFlightQuery('follow-up', history);

    const promptArg = mockExtract.mock.calls[0]?.[3] as string;
    // The oversized entry must be clamped: the prompt should not contain the full 5000-char string
    expect(promptArg).not.toContain(oversizedContent);
    // But the first 2000 chars of the entry content must be present
    expect(promptArg).toContain('x'.repeat(2000));
    // The trailing chars beyond 2000 must be absent
    expect(promptArg.indexOf('x'.repeat(2001))).toBe(-1);
  });

  it('throws when api key is missing', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findFirst).mockResolvedValueOnce({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as never);

    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await expect(parseFlightQuery('JFK to LAX')).rejects.toThrow('Missing API key');
    } finally {
      process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('uses the DB-stored key over the env var when parsing (#149 parity)', async () => {
    const { prisma } = await import('@/lib/prisma');
    const { encryptSecret } = await import('@/lib/secret-crypto');
    vi.mocked(prisma.extractionConfig.findFirst).mockResolvedValueOnce({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      anthropicApiKey: encryptSecret('stored-parse-key'),
    } as never);
    mockExtract.mockResolvedValue({
      content: makeLlmResponse({
        confidence: 'high',
        ambiguities: [],
        parsed: {
          origins: [{ code: 'JFK', name: 'New York JFK' }],
          destinations: [{ code: 'LAX', name: 'Los Angeles' }],
          dateFrom: '2026-06-15', dateTo: '2026-06-22', flexibility: 0,
          maxPrice: null, maxStops: null, preferredAirlines: [],
          timePreference: 'any', cabinClass: 'economy', tripType: 'round_trip', currency: 'USD',
        },
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await parseFlightQuery('JFK to LAX June 15-22');

    // env ANTHROPIC_API_KEY is 'test-key'; the stored key must win.
    expect(mockExtract.mock.calls[0]![0]).toBe('stored-parse-key');
  });
});
