import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: { findUnique: mockFindUnique, findMany: mockFindMany },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

import { getQueryJson, getQueryListJson } from '../lib/json-output.js';

const FAR_FUTURE = new Date('2099-12-31T00:00:00Z');
const PAST_DAY = new Date('2020-01-01T00:00:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    origin: 'JFK',
    originName: 'New York JFK',
    destination: 'LHR',
    destinationName: 'London Heathrow',
    dateFrom: new Date('2099-07-01T00:00:00Z'),
    dateTo: new Date('2099-07-14T00:00:00Z'),
    tripType: 'round_trip',
    cabinClass: 'economy',
    currency: 'USD',
    active: true,
    expiresAt: FAR_FUTURE,
    snapshots: [],
    fetchRuns: [],
    ...over,
  };
}

function snap(over: Record<string, unknown> = {}) {
  return {
    price: 600,
    currency: 'USD',
    airline: 'Delta',
    stops: 0,
    duration: '7h',
    bookingUrl: 'https://book/x',
    travelDate: new Date('2099-07-01T00:00:00Z'),
    scrapedAt: new Date('2026-06-01T09:00:00Z'),
    ...over,
  };
}

describe('getQueryJson', () => {
  beforeEach(() => mockFindUnique.mockReset());

  it('returns null when the tracker does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await getQueryJson('nope')).toBeNull();
  });

  it('includes iata codes, best price as the minimum, and the full booking url', async () => {
    const longUrl = 'https://www.delta.com/booking?tfs=' + 'y'.repeat(80);
    mockFindUnique.mockResolvedValue(
      row({
        snapshots: [
          snap({ price: 700, airline: 'United', bookingUrl: 'https://united/x' }),
          snap({ price: 540, airline: 'Delta', bookingUrl: longUrl }),
        ],
        fetchRuns: [{ startedAt: new Date('2026-06-01T09:00:00Z') }],
      }),
    );

    const data = await getQueryJson('q1');
    expect(data?.origin).toBe('JFK');
    expect(data?.destination).toBe('LHR');
    expect(data?.bestPrice?.price).toBe(540);
    expect(data?.bestPrice?.airline).toBe('Delta');
    expect(data?.bestPrice?.bookingUrl).toBe(longUrl);
    expect(data?.snapshotCount).toBe(2);
    expect(data?.expired).toBe(false);
    expect(data?.lastScraped).toBe('2026-06-01T09:00:00.000Z');
    expect(typeof data?.dateFrom).toBe('string');
  });

  it('marks a tracker whose departure day has passed as expired', async () => {
    mockFindUnique.mockResolvedValue(row({ dateFrom: PAST_DAY, dateTo: PAST_DAY }));
    const data = await getQueryJson('q1');
    expect(data?.expired).toBe(true);
  });
});

describe('getQueryListJson', () => {
  beforeEach(() => mockFindMany.mockReset());

  it('returns summaries with computed min and max prices', async () => {
    mockFindMany.mockResolvedValue([
      row({ id: 'a', snapshots: [{ price: 120 }, { price: 250 }, { price: 340 }] }),
    ]);
    const list = await getQueryListJson();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('a');
    expect(list[0]!.snapshotCount).toBe(3);
    expect(list[0]!.minPrice).toBe(120);
    expect(list[0]!.maxPrice).toBe(340);
  });

  it('reports null prices when a tracker has no snapshots', async () => {
    mockFindMany.mockResolvedValue([row({ id: 'b', snapshots: [] })]);
    const list = await getQueryListJson();
    expect(list[0]!.minPrice).toBeNull();
    expect(list[0]!.maxPrice).toBeNull();
  });
});
