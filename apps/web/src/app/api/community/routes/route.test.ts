import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGroupBy, mockFindMany, mockGet, mockSet, mockDel } = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockFindMany: vi.fn(),
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockDel: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    communitySnapshot: { groupBy: mockGroupBy, findMany: mockFindMany },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: { get: mockGet, set: mockSet, del: mockDel },
}));

import { GET } from './route';

const scrapedAt = new Date('2026-06-01T12:00:00Z');

function groupedRows() {
  return [
    {
      origin: 'JFK',
      destination: 'LAX',
      _count: { id: 42 },
      _avg: { price: 350.6 },
      _min: { price: 200 },
      _max: { price: 500, scrapedAt },
    },
    {
      origin: 'SFO',
      destination: 'ORD',
      _count: { id: 10 },
      _avg: { price: 220.2 },
      _min: { price: 150 },
      _max: { price: 300, scrapedAt },
    },
  ];
}

function airlineRows() {
  return [
    { origin: 'JFK', destination: 'LAX', airline: 'Delta' },
    { origin: 'JFK', destination: 'LAX', airline: 'United' },
    { origin: 'SFO', destination: 'ORD', airline: 'American' },
  ];
}

describe('GET /api/community/routes', () => {
  beforeEach(() => {
    mockGroupBy.mockReset().mockResolvedValue(groupedRows());
    mockFindMany.mockReset().mockResolvedValue(airlineRows());
    mockGet.mockReset().mockResolvedValue(null); // cache miss
    mockSet.mockReset().mockResolvedValue('OK'); // lock acquired
    mockDel.mockClear().mockResolvedValue(1);
  });

  it('returns the assembled route summary on a cache miss', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    const jfk = body.data.find((r: { origin: string }) => r.origin === 'JFK');
    expect(jfk.snapshotCount).toBe(42);
    expect(jfk.avgPrice).toBe(351); // rounded
    expect(jfk.airlines).toEqual(['Delta', 'United']);
    expect(jfk.latestScrapedAt).toBe(scrapedAt.toISOString());
  });

  it('uses a bounded number of DB queries (no per-route fan-out)', async () => {
    await GET();
    // One groupBy for aggregates plus one findMany for airlines, regardless of
    // how many routes are returned. The old code issued ~2N+1 queries.
    expect(mockGroupBy).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('serves the cached value without touching the database on a hit', async () => {
    mockGet.mockResolvedValue(JSON.stringify([
      { origin: 'JFK', destination: 'LAX', snapshotCount: 1, avgPrice: 1, minPrice: 1, maxPrice: 1, airlines: [], latestScrapedAt: '' },
    ]));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mockGroupBy).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('does not stampede the DB when it loses the rebuild lock and the winner populates the cache', async () => {
    // Lock is already held by another request.
    mockSet.mockResolvedValue(null);
    // First poll still empty, second poll sees the winner's cached result.
    mockGet
      .mockResolvedValueOnce(null) // initial read: miss
      .mockResolvedValueOnce(null) // first poll
      .mockResolvedValue(JSON.stringify([
        { origin: 'JFK', destination: 'LAX', snapshotCount: 7, avgPrice: 7, minPrice: 7, maxPrice: 7, airlines: [], latestScrapedAt: '' },
      ]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].snapshotCount).toBe(7);
    // It waited for the winner instead of rebuilding.
    expect(mockGroupBy).not.toHaveBeenCalled();
  });

  it('caches the freshly built result after winning the lock', async () => {
    await GET();
    // The cache write uses the data key (not the lock key).
    const cacheWrite = mockSet.mock.calls.find((c) => c[0] === 'community:routes');
    expect(cacheWrite).toBeDefined();
    // The lock is released afterwards.
    expect(mockDel).toHaveBeenCalledWith('community:routes:lock');
  });

  it('returns an empty list when there are no snapshots', async () => {
    mockGroupBy.mockResolvedValue([]);
    const res = await GET();
    const body = await res.json();
    expect(body.data).toEqual([]);
    // No airline query needed when there are no routes.
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
