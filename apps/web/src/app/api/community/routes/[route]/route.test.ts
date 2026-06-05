import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ------- hoisted mocks -------------------------------------------------------

const { mockIncr, mockExpire, mockGet, mockSet, mockFindMany } = vi.hoisted(() => ({
  mockIncr: vi.fn(),
  mockExpire: vi.fn(),
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    communitySnapshot: { findMany: mockFindMany },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: { incr: mockIncr, expire: mockExpire, get: mockGet, set: mockSet },
  cached: vi.fn(async (key: string, fn: () => Promise<unknown>, _ttl: number) => {
    // Bypass the actual cached() wrapper: always call fn() so tests control DB output.
    return fn();
  }),
}));

vi.mock('@/lib/trusted-ip', () => ({
  getClientIp: (_req: unknown) => '10.0.0.1',
}));

vi.mock('@/lib/iata-codes', () => ({
  isValidIATA: (code: string) => ['JFK', 'CDG', 'LHR', 'LAX'].includes(code),
}));

// ------- import after mocks --------------------------------------------------

import { GET } from './route';

// ------- helpers -------------------------------------------------------------

function makeRequest(route: string, ip = '10.0.0.1'): [NextRequest, { params: Promise<{ route: string }> }] {
  const req = new NextRequest(`http://localhost/api/community/routes/${route}`, {
    headers: { 'x-forwarded-for': ip },
  });
  return [req, { params: Promise.resolve({ route }) }];
}

function goodSnapshots() {
  return [
    {
      travelDate: new Date('2026-08-01'),
      price: 450,
      currency: 'USD',
      airline: 'Delta',
      stops: 0,
      cabinClass: 'economy',
      scrapedAt: new Date('2026-06-01T12:00:00Z'),
    },
  ];
}

// ------- tests ---------------------------------------------------------------

describe('GET /api/community/routes/[route]', () => {
  beforeEach(() => {
    mockIncr.mockReset();
    mockExpire.mockReset();
    mockGet.mockReset();
    mockSet.mockReset();
    mockFindMany.mockReset();

    // Default: well under the rate limit (count = 1 on first call).
    mockIncr.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);
    // Cache miss by default so fn() is always called (see cached mock above).
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');
  });

  it('returns 400 for a malformed route segment', async () => {
    const [req, ctx] = makeRequest('JFKCDG'); // no dash
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid IATA codes', async () => {
    const [req, ctx] = makeRequest('XXX-YYY');
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 200 with price data for a valid route', async () => {
    mockFindMany.mockResolvedValue(goodSnapshots());
    const [req, ctx] = makeRequest('JFK-CDG');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.origin).toBe('JFK');
    expect(body.data.destination).toBe('CDG');
    expect(body.data.prices).toHaveLength(1);
    expect(body.data.prices[0].price).toBe(450);
  });

  it('returns 429 with Retry-After when the per-IP limit is exceeded', async () => {
    // Simulate counter already over the 60 req/min ceiling.
    mockIncr.mockResolvedValue(61);
    const [req, ctx] = makeRequest('JFK-CDG');
    const res = await GET(req, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    // DB must not be touched after a rate-limit rejection.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('sets a TTL on the first increment so the window expires automatically', async () => {
    mockIncr.mockResolvedValue(1);
    mockFindMany.mockResolvedValue([]);
    const [req, ctx] = makeRequest('JFK-CDG');
    await GET(req, ctx);
    expect(mockExpire).toHaveBeenCalledWith('community:route:rl:10.0.0.1', 60);
  });

  it('does not call expire after the first increment (window already set)', async () => {
    // count = 5 means the key was already created on an earlier request.
    mockIncr.mockResolvedValue(5);
    mockFindMany.mockResolvedValue([]);
    const [req, ctx] = makeRequest('JFK-CDG');
    await GET(req, ctx);
    expect(mockExpire).not.toHaveBeenCalled();
  });

  it('allows requests through when Redis is unavailable (fail-open)', async () => {
    mockIncr.mockRejectedValue(new Error('ECONNREFUSED'));
    mockFindMany.mockResolvedValue(goodSnapshots());
    const [req, ctx] = makeRequest('LHR-LAX');
    const res = await GET(req, ctx);
    // Should not 429 on Redis failure.
    expect(res.status).toBe(200);
  });
});
