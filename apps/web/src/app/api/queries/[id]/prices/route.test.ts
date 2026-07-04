import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQueryFindUnique = vi.fn();
const mockSnapshotFindMany = vi.fn();
const mockFetchRunFindFirst = vi.fn();
const mockExtractionConfigFindFirst = vi.fn().mockResolvedValue({ scrapeInterval: 3 });
const mockQueryEditEventFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: { findUnique: (...args: unknown[]) => mockQueryFindUnique(...args) },
    priceSnapshot: { findMany: (...args: unknown[]) => mockSnapshotFindMany(...args) },
    fetchRun: { findFirst: (...args: unknown[]) => mockFetchRunFindFirst(...args) },
    extractionConfig: { findFirst: (...args: unknown[]) => mockExtractionConfigFindFirst(...args) },
    queryEditEvent: { findMany: (...args: unknown[]) => mockQueryEditEventFindMany(...args) },
  },
}));

vi.mock('@/lib/redis', () => ({
  cached: (_key: string, fn: () => Promise<unknown>) => fn(),
}));

import { GET } from './route';

const request = new NextRequest('http://localhost/api/queries/test-id/prices');

function futureDate(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function callGet(id = 'test-id') {
  return GET(request, { params: Promise.resolve({ id }) });
}

describe('GET /api/queries/[id]/prices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractionConfigFindFirst.mockResolvedValue({ scrapeInterval: 3 });
    mockSnapshotFindMany.mockResolvedValue([]);
    mockFetchRunFindFirst.mockResolvedValue(null);
    mockQueryEditEventFindMany.mockResolvedValue([]);
  });

  it('returns 404 for nonexistent query', async () => {
    mockQueryFindUnique.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it('returns 410 for expired query', async () => {
    mockQueryFindUnique.mockResolvedValue({
      id: 'test-id',
      expiresAt: new Date('2020-01-01'),
    });
    const res = await callGet();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain('expired');
  });

  it('returns price snapshots for valid query', async () => {
    mockQueryFindUnique.mockResolvedValue({
      id: 'test-id',
      origin: 'JFK',
      destination: 'LAX',
      expiresAt: futureDate(),
    });
    mockSnapshotFindMany.mockResolvedValue([
      { id: 's1', price: 300, airline: 'Delta' },
    ]);
    mockFetchRunFindFirst.mockResolvedValue({
      startedAt: new Date('2026-06-01'),
      status: 'success',
    });

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.snapshots).toHaveLength(1);
    expect(body.data.snapshotCount).toBe(1);
  });

  it('includes lastChecked from most recent fetch run', async () => {
    mockQueryFindUnique.mockResolvedValue({ id: 'test-id', expiresAt: futureDate() });
    mockSnapshotFindMany.mockResolvedValue([]);
    mockFetchRunFindFirst.mockResolvedValue({
      startedAt: new Date('2026-06-01T10:00:00Z'),
      status: 'success',
    });

    const res = await callGet();
    const body = await res.json();
    expect(body.data.lastChecked).toBeTruthy();
    expect(body.data.lastStatus).toBe('success');
  });

  it('returns null lastChecked when no fetch runs', async () => {
    mockQueryFindUnique.mockResolvedValue({ id: 'test-id', expiresAt: futureDate() });
    mockSnapshotFindMany.mockResolvedValue([]);
    mockFetchRunFindFirst.mockResolvedValue(null);

    const res = await callGet();
    const body = await res.json();
    expect(body.data.lastChecked).toBeNull();
    expect(body.data.lastStatus).toBeNull();
  });

  it('passes take: 5000 and orderBy desc to priceSnapshot.findMany (DB-2 bound)', async () => {
    mockQueryFindUnique.mockResolvedValue({ id: 'test-id', expiresAt: futureDate() });
    mockSnapshotFindMany.mockResolvedValue([]);

    await callGet();

    expect(mockSnapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5000,
        orderBy: { scrapedAt: 'desc' },
      }),
    );
  });

  it('returns snapshots in ascending chronological order regardless of DB fetch order', async () => {
    mockQueryFindUnique.mockResolvedValue({ id: 'test-id', expiresAt: futureDate() });
    // Mock returns desc order (newest first) as the route requests
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-02-01T00:00:00.000Z';
    const t3 = '2026-03-01T00:00:00.000Z';
    mockSnapshotFindMany.mockResolvedValue([
      { id: 's3', price: 300, scrapedAt: t3 },
      { id: 's2', price: 200, scrapedAt: t2 },
      { id: 's1', price: 100, scrapedAt: t1 },
    ]);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    // After in-memory reverse, order must be ascending
    expect(body.data.snapshots[0].id).toBe('s1');
    expect(body.data.snapshots[1].id).toBe('s2');
    expect(body.data.snapshots[2].id).toBe('s3');
  });

  it('filters snapshots by current tracker filters and reports total count', async () => {
    mockQueryFindUnique.mockResolvedValue({
      id: 'test-id',
      expiresAt: futureDate(),
      maxStops: 0,
      maxPrice: null,
      maxDurationHours: null,
      preferredAirlines: [],
    });
    mockSnapshotFindMany.mockResolvedValue([
      { id: 's2', price: 200, stops: 1, duration: null, airline: 'United', scrapedAt: '2026-02-01T00:00:00.000Z' },
      { id: 's1', price: 300, stops: 0, duration: null, airline: 'Delta', scrapedAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.snapshots).toHaveLength(1);
    expect(body.data.snapshots[0].id).toBe('s1');
    expect(body.data.snapshotCount).toBe(1);
    expect(body.data.totalSnapshotCount).toBe(2);
  });

  it('includes tracker edit events for chart annotations', async () => {
    mockQueryFindUnique.mockResolvedValue({ id: 'test-id', expiresAt: futureDate() });
    mockQueryEditEventFindMany.mockResolvedValue([
      { id: 'e2', editedAt: new Date('2026-03-01T00:00:00Z'), summary: 'Price cap changed', changes: { changes: [] } },
      { id: 'e1', editedAt: new Date('2026-02-01T00:00:00Z'), summary: 'Nonstop only enabled', changes: { changes: [] } },
    ]);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockQueryEditEventFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { editedAt: 'desc' },
      take: 25,
    }));
    expect(body.data.editEvents).toHaveLength(2);
    expect(body.data.editEvents[0].summary).toBe('Nonstop only enabled');
    expect(body.data.editEvents[1].summary).toBe('Price cap changed');
  });
});
