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
      id: 'u1', username: 'alice', displayName: 'Alice',
      defaultCurrency: 'USD', defaultCountry: 'US',
      preferredAirlines: ['Delta'], cabinClass: 'economy',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.defaultCurrency).toBe('USD');
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
});
