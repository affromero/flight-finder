import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockParseFlightQuery = vi.fn();

// Shared Redis mock so individual tests can override incr behaviour. Defined via
// vi.hoisted because the vi.mock factory below reads it eagerly, so it must be
// initialized before the hoisted factory runs.
const mockRedis = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: mockRedis,
}));

vi.mock('@/lib/scraper/parse-query', () => ({
  parseFlightQuery: (...args: unknown[]) => mockParseFlightQuery(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    apiUsageLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}));

import { POST } from './route';

function makeRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/parse', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Default: rate limiter allows the request (count well under limit). */
function allowRateLimit(): void {
  mockRedis.incr.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.ttl.mockResolvedValue(60);
}

describe('POST /api/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowRateLimit();
    delete process.env.TRUSTED_FORWARDED_FOR;
  });

  afterEach(() => {
    delete process.env.TRUSTED_FORWARDED_FOR;
  });

  // --- Existing validation tests ---

  it('rejects missing query field with 400', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('rejects query shorter than 5 chars with 400', async () => {
    const res = await POST(makeRequest({ query: 'ab' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('between 5 and 500');
  });

  it('rejects query longer than 500 chars with 400', async () => {
    const res = await POST(makeRequest({ query: 'a'.repeat(501) }));
    expect(res.status).toBe(400);
  });

  it('returns parsed flight data on success', async () => {
    const parseResponse = {
      parsed: { origin: 'JFK', destination: 'LAX' },
      confidence: 'high',
      ambiguities: [],
      dateSpanDays: 7,
    };
    mockParseFlightQuery.mockResolvedValue({
      response: parseResponse,
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const res = await POST(makeRequest({ query: 'JFK to LAX June 15-22' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.confidence).toBe('high');
  });

  it('returns 422 when parse throws', async () => {
    mockParseFlightQuery.mockRejectedValue(new Error('LLM exploded'));
    const res = await POST(makeRequest({ query: 'JFK to LAX June 15' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('LLM exploded');
  });

  it('logs api usage after successful parse', async () => {
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await POST(makeRequest({ query: 'JFK to LAX June 15' }));

    const { prisma } = await import('@/lib/prisma');
    expect(prisma.apiUsageLog.create).toHaveBeenCalled();
  });

  // --- Rate limiting ---

  it('returns 429 with Retry-After when the per-IP rate limit is exceeded', async () => {
    // Simulate counter already over the 30-request limit
    mockRedis.incr.mockResolvedValue(31);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(45);

    const res = await POST(makeRequest({ query: 'JFK to LAX June 15' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('45');
    const body = await res.json();
    expect(body.ok).toBe(false);
    // parseFlightQuery must not be called when rate-limited
    expect(mockParseFlightQuery).not.toHaveBeenCalled();
  });

  it('allows the request when Redis is unavailable (fail-open)', async () => {
    mockRedis.incr.mockRejectedValue(new Error('Redis down'));
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const res = await POST(makeRequest({ query: 'JFK to LAX June 15' }));
    // Should succeed (fail-open) rather than blocking the user
    expect(res.status).toBe(200);
  });

  it('uses x-forwarded-for as the rate-limit key when a proxy is trusted', async () => {
    mockRedis.incr.mockResolvedValue(31);
    mockRedis.ttl.mockResolvedValue(30);

    const res = await POST(
      makeRequest({ query: 'JFK to LAX June 15' }, { 'x-forwarded-for': '10.0.0.5, 10.0.0.1' }),
    );
    expect(res.status).toBe(429);
    // The rate key must be keyed to the first forwarded IP
    expect(mockRedis.incr).toHaveBeenCalledWith('parse-rate:10.0.0.5');
  });

  it('collapses spoofed x-forwarded-for into one rate-limit bucket when no proxy is trusted', async () => {
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    // Allow first two requests through, block nothing yet
    mockRedis.incr.mockResolvedValue(1);
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await POST(makeRequest({ query: 'JFK to LAX June 15' }, { 'x-forwarded-for': '1.1.1.1' }));
    await POST(makeRequest({ query: 'JFK to LAX June 15' }, { 'x-forwarded-for': '2.2.2.2' }));

    // Both calls must have used the same Redis key, not one per spoofed IP
    const keys = mockRedis.incr.mock.calls.map((c: unknown[]) => c[0] as string);
    const distinct = new Set(keys);
    expect(distinct.size).toBe(1);
    expect(distinct.has('parse-rate:1.1.1.1')).toBe(false);
    expect(distinct.has('parse-rate:2.2.2.2')).toBe(false);
  });

  // --- conversationHistory input validation ---

  it('strips non-object entries from conversationHistory before forwarding to parser', async () => {
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await POST(
      makeRequest({
        query: 'JFK to LAX June 15',
        conversationHistory: [
          { role: 'user', content: 'hello' },
          null,
          42,
          'string entry',
          { role: 'assistant', content: 'reply' },
        ],
      }),
    );

    expect(mockParseFlightQuery).toHaveBeenCalledWith(
      expect.any(String),
      // Only the two valid object entries must reach the parser
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
    );
  });

  it('caps conversationHistory at 12 entries before forwarding to parser', async () => {
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const bigHistory = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    }));

    await POST(makeRequest({ query: 'JFK to LAX June 15', conversationHistory: bigHistory }));

    const forwarded = mockParseFlightQuery.mock.calls[0]?.[1] as unknown[];
    expect(forwarded).toHaveLength(12);
  });

  it('normalises unknown role values to "user" in conversationHistory', async () => {
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await POST(
      makeRequest({
        query: 'JFK to LAX June 15',
        conversationHistory: [{ role: 'system', content: 'injected' }],
      }),
    );

    const forwarded = mockParseFlightQuery.mock.calls[0]?.[1] as Array<{ role: string }>;
    expect(forwarded[0]?.role).toBe('user');
  });

  it('passes undefined for conversationHistory when field is not an array', async () => {
    mockParseFlightQuery.mockResolvedValue({
      response: { parsed: null, confidence: 'low', ambiguities: [], dateSpanDays: 0 },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await POST(makeRequest({ query: 'JFK to LAX June 15', conversationHistory: 'not-an-array' }));

    expect(mockParseFlightQuery).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});
