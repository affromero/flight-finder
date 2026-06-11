import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockUpdate = vi.fn();
const mockIsMultiUserEnabled = vi.fn();
const mockGetCurrentUser = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { update: (...args: unknown[]) => mockUpdate(...args) },
  },
}));

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { GET, PATCH } from './route';

function makePatch(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/account/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET /api/account/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(true);
  });

  it('returns 404 when multi user mode is off', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('returns 401 when no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the user preferences', async () => {
    mockGetCurrentUser.mockResolvedValue({
      id: 'u1', username: 'alice', displayName: 'Alice', avatar: 'globe', theme: 'tron-dark',
      defaultCurrency: 'USD', defaultCountry: 'US',
      preferredAirlines: ['Delta'], preferredAggregators: ['google_flights', 'skyscanner'],
      cabinClass: 'economy',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.defaultCurrency).toBe('USD');
    expect(body.data.avatar).toBe('globe');
    expect(body.data.theme).toBe('tron-dark');
    expect(body.data.preferredAggregators).toEqual(['google_flights', 'skyscanner']);
  });
});

describe('PATCH /api/account/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockUpdate.mockResolvedValue({ username: 'alice', defaultCurrency: 'EUR' });
  });

  it('rejects invalid currency code', async () => {
    const res = await PATCH(makePatch({ defaultCurrency: 'us' }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid country code', async () => {
    const res = await PATCH(makePatch({ defaultCountry: 'usa' }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid cabin class', async () => {
    const res = await PATCH(makePatch({ cabinClass: 'pony' }));
    expect(res.status).toBe(400);
  });

  it('updates preferences', async () => {
    const res = await PATCH(makePatch({ defaultCurrency: 'EUR', defaultCountry: 'DE', preferredAirlines: ['Lufthansa'] }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('rejects empty body with 400', async () => {
    const res = await PATCH(makePatch({}));
    expect(res.status).toBe(400);
  });

  it('clears values via null', async () => {
    const res = await PATCH(makePatch({ defaultCurrency: null }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.defaultCurrency).toBeNull();
  });

  it('accepts a valid preferredAggregators array', async () => {
    const res = await PATCH(makePatch({ preferredAggregators: ['google_flights', 'skyscanner'] }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.preferredAggregators).toEqual(['google_flights', 'skyscanner']);
  });

  it('accepts an empty preferredAggregators array as clear', async () => {
    const res = await PATCH(makePatch({ preferredAggregators: [] }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.preferredAggregators).toEqual([]);
  });

  it('rejects unknown aggregator value with 422', async () => {
    const res = await PATCH(makePatch({ preferredAggregators: ['google_flights', 'expedia'] }));
    expect(res.status).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects non-string aggregator entry with 422', async () => {
    const res = await PATCH(makePatch({ preferredAggregators: ['google_flights', 42] }));
    expect(res.status).toBe(422);
  });

  it('preferredAggregators field omitted does not touch the column', async () => {
    const res = await PATCH(makePatch({ defaultCurrency: 'EUR' }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data).not.toHaveProperty('preferredAggregators');
  });

  it('accepts a valid preset avatar slug', async () => {
    const res = await PATCH(makePatch({ avatar: 'globe' }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.avatar).toBe('globe');
  });

  it('rejects an unknown avatar slug with 400', async () => {
    const res = await PATCH(makePatch({ avatar: 'not-a-real-slug' }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('clears the avatar via null', async () => {
    const res = await PATCH(makePatch({ avatar: null }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.avatar).toBeNull();
  });

  it('accepts a valid personal theme id', async () => {
    const res = await PATCH(makePatch({ theme: 'tron-dark' }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.theme).toBe('tron-dark');
  });

  it('rejects an unknown theme id with 400', async () => {
    const res = await PATCH(makePatch({ theme: 'not-a-real-theme' }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('clears the personal theme via null (revert to instance default)', async () => {
    const res = await PATCH(makePatch({ theme: null }));
    expect(res.status).toBe(200);
    const args = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.theme).toBeNull();
  });
});
