import { describe, it, expect, vi, beforeEach } from 'vitest';

const VALID_TOKEN = 'ft_validkey';

const { mockFindUnique, mockCreateMany, mockUpdate, mockIncr, mockExpire } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCreateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockUpdate: vi.fn().mockResolvedValue({}),
  mockIncr: vi.fn(),
  mockExpire: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    communityApiKey: { findUnique: mockFindUnique, update: mockUpdate },
    communitySnapshot: { createMany: mockCreateMany },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: { incr: mockIncr, expire: mockExpire },
}));

import { POST } from './route';

function makeRequest(body: unknown, token: string | null = VALID_TOKEN): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/community/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// scrapedAt must be <= now; travelDate within +/- 2 years.
const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 1000).toISOString();

function validSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    origin: 'JFK',
    destination: 'LAX',
    travelDate: future,
    price: 350,
    currency: 'USD',
    airline: 'Delta',
    stops: 0,
    cabinClass: 'economy',
    scrapedAt: past,
    ...overrides,
  };
}

describe('POST /api/community/ingest', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockCreateMany.mockClear().mockResolvedValue({ count: 0 });
    mockUpdate.mockClear().mockResolvedValue({});
    mockIncr.mockReset().mockResolvedValue(1); // under the per-key cap
    mockExpire.mockClear();
    mockFindUnique.mockResolvedValue({ id: 'key_1', apiKey: VALID_TOKEN, active: true });
  });

  it('rejects a missing bearer token with 401', async () => {
    const res = await POST(makeRequest({ snapshots: [] }, null));
    expect(res.status).toBe(401);
  });

  it('rejects an unknown key with 401', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ snapshots: [validSnapshot()] }, 'ft_wrong'));
    expect(res.status).toBe(401);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('rejects a revoked (inactive) key with 401', async () => {
    mockFindUnique.mockResolvedValue({ id: 'key_1', apiKey: VALID_TOKEN, active: false });
    const res = await POST(makeRequest({ snapshots: [validSnapshot()] }));
    expect(res.status).toBe(401);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('accepts a valid batch with 200', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot()] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accepted).toBe(1);
    expect(body.data.rejected).toBe(0);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 503 when the limiter cannot be consulted (Redis error)', async () => {
    mockIncr.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(makeRequest({ snapshots: [validSnapshot()] }));
    expect(res.status).toBe(503);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('rejects over the per-key rate limit with 429', async () => {
    mockIncr.mockResolvedValueOnce(2); // over the 1-per-hour cap
    const res = await POST(makeRequest({ snapshots: [validSnapshot()] }));
    expect(res.status).toBe(429);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('rejects a batch larger than the cap with 400', async () => {
    const snapshots = Array.from({ length: 1001 }, () => validSnapshot());
    const res = await POST(makeRequest({ snapshots }));
    expect(res.status).toBe(400);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('rejects a lowercase IATA origin (must be uppercase A-Z)', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ origin: 'jfk' })] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown IATA code', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ destination: 'ZZZ' })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('rejects a travelDate far in the future (beyond the sane window)', async () => {
    const wayOut = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000).toISOString();
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ travelDate: wayOut })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('rejects a travelDate far in the past', async () => {
    const wayBack = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString();
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ travelDate: wayBack })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('accepts a high denomination currency price above the old 50k cap', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ price: 2_550_760, currency: 'COP' })] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accepted).toBe(1);
    expect(body.data.rejected).toBe(0);
  });

  it('rejects a price beyond the safe integer ceiling', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ price: Number.MAX_SAFE_INTEGER + 2 })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('rejects a non-positive price', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ price: 0 })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('rejects a cabinClass outside the allowed enum', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ cabinClass: 'royal_suite' })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('normalizes an uppercase cabinClass into the stored lowercase enum value', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ cabinClass: 'BUSINESS' })] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accepted).toBe(1);
    const createArg = mockCreateMany.mock.calls[0]![0] as { data: { cabinClass: string }[] };
    expect(createArg.data[0]!.cabinClass).toBe('business');
  });

  it('rejects an over-long airline string', async () => {
    const res = await POST(makeRequest({ snapshots: [validSnapshot({ airline: 'A'.repeat(101) })] }));
    const body = await res.json();
    expect(body.data.accepted).toBe(0);
    expect(body.data.rejected).toBe(1);
  });

  it('persists only the valid rows from a mixed batch', async () => {
    const res = await POST(makeRequest({
      snapshots: [validSnapshot(), validSnapshot({ origin: 'jfk' }), validSnapshot({ price: -5 })],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accepted).toBe(1);
    expect(body.data.rejected).toBe(2);
    const createArg = mockCreateMany.mock.calls[0]![0] as { data: unknown[] };
    expect(createArg.data).toHaveLength(1);
  });
});
