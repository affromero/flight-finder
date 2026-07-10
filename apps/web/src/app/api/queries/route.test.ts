import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockQueryCreate, mockSnapshotCreateMany } = vi.hoisted(() => ({
  mockQueryCreate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'q-' + Math.random().toString(36).slice(2, 8), ...args.data })
  ),
  mockSnapshotCreateMany: vi.fn().mockResolvedValue({ count: 0 }),
}));

// Redis mock: incr returns 1 (under limit) by default
const mockRedisIncr = vi.fn().mockResolvedValue(1);
const mockRedisExpire = vi.fn().mockResolvedValue(1);
const mockRedisTtl = vi.fn().mockResolvedValue(600);

vi.mock('@/lib/redis', () => ({
  redis: {
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    ttl: (...args: unknown[]) => mockRedisTtl(...args),
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: { create: mockQueryCreate },
    priceSnapshot: { createMany: mockSnapshotCreateMany },
  },
}));

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { POST } from './route';

function makeRequest(body: unknown, ip = '1.2.3.4'): NextRequest {
  return new NextRequest('http://localhost/api/queries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
    },
  });
}

const validBody = {
  rawInput: 'JFK to LAX June 15-22',
  dateFrom: '2026-06-15',
  dateTo: '2026-06-22',
  flexibility: 0,
  tripType: 'round_trip',
  routes: [{
    origin: 'JFK',
    originName: 'New York JFK',
    destination: 'LAX',
    destinationName: 'Los Angeles',
    selectedFlights: [],
  }],
};

describe('POST /api/queries', () => {
  beforeEach(() => {
    mockQueryCreate.mockClear();
    mockSnapshotCreateMany.mockClear();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(1);
    mockRedisTtl.mockResolvedValue(600);
  });

  it('allows unauthenticated request (public endpoint)', async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
  });

  it('rejects invalid json body with 400', async () => {
    const req = new NextRequest('http://localhost/api/queries', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects missing required fields with 400', async () => {
    const res = await POST(makeRequest({ routes: [{ origin: 'JFK', destination: 'LAX', selectedFlights: [] }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('rawInput');
  });

  it('rejects invalid airport code with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{ origin: 'XX', destination: 'LAX', originName: 'X', destinationName: 'LA', selectedFlights: [] }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid airport code');
  });

  it('rejects invalid date format with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, dateFrom: 'notadate' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid date');
  });

  it('rejects dateFrom after dateTo for roundtrip with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      dateFrom: '2026-07-01',
      dateTo: '2026-06-15',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('dateFrom must be before dateTo');
  });

  it('allows dateFrom equal dateTo for one-way', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      dateFrom: '2026-06-15',
      dateTo: '2026-06-15',
      tripType: 'one_way',
    }));
    expect(res.status).toBe(201);
  });

  it('creates query and returns 201 on success', async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.queries).toHaveLength(1);
    expect(body.data.queries[0].origin).toBe('JFK');
    expect(body.data.queries[0].deleteToken).toBeDefined();
  });

  it('caps flexibility at 14 days', async () => {
    await POST(makeRequest({ ...validBody, flexibility: 100 }));
    const createArg = mockQueryCreate.mock.calls[0]![0] as { data: { flexibility: number } };
    expect(createArg.data.flexibility).toBe(14);
  });

  it('defaults currency to null when not provided', async () => {
    await POST(makeRequest({ ...validBody, currency: undefined }));
    const createArg = mockQueryCreate.mock.calls[0]![0] as { data: { currency: string | null } };
    expect(createArg.data.currency).toBeNull();
  });

  it('creates initial price snapshots from selected flights', async () => {
    const bodyWithFlights = {
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 300, airline: 'Delta', bookingUrl: 'https://delta.com' },
        ],
      }],
    };
    await POST(makeRequest(bodyWithFlights));
    expect(mockSnapshotCreateMany).toHaveBeenCalled();
  });

  // Issue 65: a picked Turkish flight used to silently flag the saved query as
  // preferredAirlines=['Turkish'], which then routed cron through a broken
  // turkishairlines.com URL forever. Picked flights now seed snapshots only and
  // never poison the cron navigation strategy.
  it('does NOT auto-derive preferredAirlines from selectedFlights when preferredAirlines is empty', async () => {
    const bodyWithPickedTurkish = {
      ...validBody,
      preferredAirlines: [],
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 431, airline: 'Turkish Airlines', bookingUrl: 'https://turkishairlines.com' },
        ],
      }],
    };
    await POST(makeRequest(bodyWithPickedTurkish));
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { preferredAirlines: string[] } };
    expect(createCall.data.preferredAirlines).toEqual([]);
  });

  it('preserves explicit preferredAirlines even when selectedFlights contain other airlines', async () => {
    const bodyWithExplicitAirlines = {
      ...validBody,
      preferredAirlines: ['Lufthansa'],
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 431, airline: 'Turkish Airlines', bookingUrl: 'https://turkishairlines.com' },
        ],
      }],
    };
    await POST(makeRequest(bodyWithExplicitAirlines));
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { preferredAirlines: string[] } };
    expect(createCall.data.preferredAirlines).toEqual(['Lufthansa']);
  });

  it('supports multi-route format', async () => {
    const multiRoute = {
      ...validBody,
      routes: [
        { origin: 'JFK', originName: 'JFK', destination: 'LAX', destinationName: 'LAX', selectedFlights: [] },
        { origin: 'LAX', originName: 'LAX', destination: 'SFO', destinationName: 'SFO', selectedFlights: [] },
      ],
    };
    const res = await POST(makeRequest(multiRoute));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.queries).toHaveLength(2);
  });

  it('persists return date separately from outbound date on round-trip pinned routes', async () => {
    const pinnedRoundTrip = {
      ...validBody,
      routes: [{
        origin: 'JFK',
        originName: 'New York JFK',
        destination: 'CDG',
        destinationName: 'Paris CDG',
        date: '2026-06-15',
        returnDate: '2026-06-22',
        selectedFlights: [],
      }],
    };
    const res = await POST(makeRequest(pinnedRoundTrip));
    expect(res.status).toBe(201);

    const createCall = mockQueryCreate.mock.calls[0]![0];
    expect(createCall.data.dateFrom).toEqual(new Date('2026-06-15T00:00:00Z'));
    expect(createCall.data.dateTo).toEqual(new Date('2026-06-22T00:00:00Z'));

    const body = await res.json();
    expect(body.data.queries[0].date).toBe('2026-06-15');
    expect(body.data.queries[0].returnDate).toBe('2026-06-22');
  });

  it('falls back to outbound date for dateTo when returnDate is absent (one-way)', async () => {
    const pinnedOneWay = {
      ...validBody,
      tripType: 'one_way',
      routes: [{
        origin: 'JFK',
        originName: 'New York JFK',
        destination: 'LAX',
        destinationName: 'Los Angeles',
        date: '2026-06-15',
        selectedFlights: [],
      }],
    };
    const res = await POST(makeRequest(pinnedOneWay));
    expect(res.status).toBe(201);

    const createCall = mockQueryCreate.mock.calls[0]![0];
    expect(createCall.data.dateFrom).toEqual(new Date('2026-06-15T00:00:00Z'));
    expect(createCall.data.dateTo).toEqual(new Date('2026-06-15T00:00:00Z'));
  });

  it('rejects anonymous submission with 401 when multi user mode is on', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('attaches userId when a user session is present in multi user mode', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'user_42' });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { userId: string | null } };
    expect(createCall.data.userId).toBe('user_42');
  });

  it('leaves userId null in solo mode even when a user session is present', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue({ id: 'user_42' });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { userId: string | null } };
    expect(createCall.data.userId).toBeNull();
  });

  it('stores label when provided', async () => {
    const res = await POST(makeRequest({ ...validBody, label: 'Paris via Google' }));
    expect(res.status).toBe(201);
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { label: string | null } };
    expect(createCall.data.label).toBe('Paris via Google');
  });

  it('stores label as null when omitted', async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const createCall = mockQueryCreate.mock.calls[0]![0] as { data: { label: string | null } };
    expect(createCall.data.label).toBeNull();
  });

  it('rejects label longer than 60 characters', async () => {
    const res = await POST(makeRequest({ ...validBody, label: 'a'.repeat(61) }));
    expect(res.status).toBe(400);
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects routes[] exceeding MAX_ROUTES (20) with 400', async () => {
    const tooManyRoutes = Array.from({ length: 21 }, () => ({
      origin: 'JFK',
      originName: 'New York JFK',
      destination: 'LAX',
      destinationName: 'Los Angeles',
      selectedFlights: [],
    }));
    const res = await POST(makeRequest({ ...validBody, routes: tooManyRoutes }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Too many routes');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects selectedFlights[] exceeding MAX_FLIGHTS_PER_ROUTE (50) with 400', async () => {
    const tooManyFlights = Array.from({ length: 51 }, (_, i) => ({
      travelDate: '2026-06-15',
      price: 300 + i,
      airline: 'Delta',
      bookingUrl: 'https://delta.com',
    }));
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        origin: 'JFK',
        originName: 'New York JFK',
        destination: 'LAX',
        destinationName: 'Los Angeles',
        selectedFlights: tooManyFlights,
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Too many flights');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  // ---- Field size / type validation (Finding G) ----

  it('rejects rawInput exceeding 500 characters with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, rawInput: 'x'.repeat(501) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('rawInput');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects originName exceeding 200 characters with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        originName: 'O'.repeat(201),
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('originName');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects destinationName exceeding 200 characters with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        destinationName: 'D'.repeat(201),
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('destinationName');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects a preferredAirlines entry exceeding 100 characters with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, preferredAirlines: ['A'.repeat(101)] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('preferredAirlines');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects maxPrice that is not a finite number with 400', async () => {
    // A non-numeric value survives JSON transport (Infinity/NaN serialize to
    // null, which the route treats as "unset"). Number('not-a-number') is NaN.
    const res = await POST(makeRequest({ ...validBody, maxPrice: 'not-a-number' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxPrice');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects maxPrice above the safe-integer ceiling with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, maxPrice: Number.MAX_SAFE_INTEGER + 1 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxPrice');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  // A COP fare of ~USD 600 is 2,550,760 pesos; the old 1M cap rejected it at
  // the route level, so guard acceptance here and not only in the helper test.
  it('accepts a high denomination maxPrice and selected flight price above the old 1M cap', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      maxPrice: 3_000_000,
      currency: 'COP',
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 2_550_760, airline: 'Avianca', bookingUrl: 'https://avianca.com' },
        ],
      }],
    }));
    expect(res.status).toBe(201);
    const createArg = mockQueryCreate.mock.calls[0]![0] as { data: { maxPrice: number } };
    expect(createArg.data.maxPrice).toBe(3_000_000);
    expect(mockSnapshotCreateMany).toHaveBeenCalled();
  });

  it('rejects maxStops outside 0-10 range with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, maxStops: 11 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxStops');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects maxStops that is a non-integer with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, maxStops: 1.5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxStops');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects a route with an invalid pinned date with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        date: 'not-a-date',
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('date');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects a route with an invalid returnDate with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        date: '2026-06-15',
        returnDate: 'bad-date',
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('returnDate');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects a selected flight with an invalid travelDate with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [{ travelDate: 'nope', price: 200, airline: 'Delta', bookingUrl: null }],
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('travelDate');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects a selected flight with a non-finite price with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [{ travelDate: '2026-06-15', price: 'not-a-number', airline: 'Delta', bookingUrl: null }],
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('price');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('rejects a selected flight with an airline name exceeding 100 characters with 400', async () => {
    const res = await POST(makeRequest({
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [{ travelDate: '2026-06-15', price: 200, airline: 'A'.repeat(101), bookingUrl: null }],
      }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('airline');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('stores empty string for a non-http bookingUrl (javascript: scheme dropped)', async () => {
    const bodyWithBadUrl = {
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 300, airline: 'Delta', bookingUrl: 'javascript:alert(1)' },
        ],
      }],
    };
    const res = await POST(makeRequest(bodyWithBadUrl));
    expect(res.status).toBe(201);
    const snapshotCall = mockSnapshotCreateMany.mock.calls[0]![0] as {
      data: Array<{ bookingUrl: string }>;
    };
    expect(snapshotCall.data[0]!.bookingUrl).toBe('');
  });

  it('stores empty string for a data: bookingUrl', async () => {
    const bodyWithDataUrl = {
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 300, airline: 'Delta', bookingUrl: 'data:text/html,<h1>x</h1>' },
        ],
      }],
    };
    const res = await POST(makeRequest(bodyWithDataUrl));
    expect(res.status).toBe(201);
    const snapshotCall = mockSnapshotCreateMany.mock.calls[0]![0] as {
      data: Array<{ bookingUrl: string }>;
    };
    expect(snapshotCall.data[0]!.bookingUrl).toBe('');
  });

  it('stores the URL for a valid https bookingUrl', async () => {
    const url = 'https://www.delta.com/book/123';
    const bodyWithValidUrl = {
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: 300, airline: 'Delta', bookingUrl: url },
        ],
      }],
    };
    const res = await POST(makeRequest(bodyWithValidUrl));
    expect(res.status).toBe(201);
    const snapshotCall = mockSnapshotCreateMany.mock.calls[0]![0] as {
      data: Array<{ bookingUrl: string }>;
    };
    expect(snapshotCall.data[0]!.bookingUrl).toBe(url);
  });

  it('rejects an impossible calendar date (2026-02-31) with 400', async () => {
    const res = await POST(makeRequest({ ...validBody, dateFrom: '2026-02-31' }));
    expect(res.status).toBe(400);
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('stores a numeric-string price as a number, not a string', async () => {
    const bodyWithStringPrice = {
      ...validBody,
      routes: [{
        ...validBody.routes[0],
        selectedFlights: [
          { travelDate: '2026-06-15', price: '300', airline: 'Delta', bookingUrl: null, stops: '1' },
        ],
      }],
    };
    const res = await POST(makeRequest(bodyWithStringPrice));
    expect(res.status).toBe(201);
    const snapshotCall = mockSnapshotCreateMany.mock.calls[0]![0] as {
      data: Array<{ price: unknown; stops: unknown }>;
    };
    expect(snapshotCall.data[0]!.price).toBe(300);
    expect(typeof snapshotCall.data[0]!.price).toBe('number');
    expect(snapshotCall.data[0]!.stops).toBe(1);
    expect(typeof snapshotCall.data[0]!.stops).toBe('number');
  });

  // ---- Per-IP rate limit (Finding G) ----

  it('returns 429 when per-IP creation rate is exceeded', async () => {
    // Simulate incr returning a count above the limit (20)
    mockRedisIncr.mockResolvedValue(21);
    mockRedisTtl.mockResolvedValue(540);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many tracker requests');
    expect(mockQueryCreate).not.toHaveBeenCalled();
  });

  it('includes Retry-After header on 429 rate limit response', async () => {
    mockRedisIncr.mockResolvedValue(21);
    mockRedisTtl.mockResolvedValue(300);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('allows the request when Redis is unavailable (fail-open)', async () => {
    mockRedisIncr.mockRejectedValue(new Error('Redis connection refused'));

    const res = await POST(makeRequest(validBody));
    // Should still succeed -- Redis failure must not block query creation
    expect(res.status).toBe(201);
  });
});
