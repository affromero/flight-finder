import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockQueryCreate, mockSnapshotCreateMany } = vi.hoisted(() => ({
  mockQueryCreate: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'q-' + Math.random().toString(36).slice(2, 8), ...args.data })
  ),
  mockSnapshotCreateMany: vi.fn().mockResolvedValue({ count: 0 }),
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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/queries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
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
});
