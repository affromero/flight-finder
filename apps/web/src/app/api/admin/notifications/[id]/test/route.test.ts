import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { encryptSecret } from '@/lib/secret-crypto';

const mockChannelFindFirst = vi.fn();
const mockConfigFindFirst = vi.fn();
const mockRequireAdmin = vi.fn().mockResolvedValue(null);
const mockRedisSet = vi.fn();
// Holder so individual tests can swap the redis client (null = throttle off,
// object = throttle on, with mockRedisSet controlling reserve/error behaviour).
const redisHolder: { redis: { set: typeof mockRedisSet } | null } = { redis: null };

vi.mock('@/lib/prisma', () => ({
  prisma: {
    notificationChannel: { findFirst: (...a: unknown[]) => mockChannelFindFirst(...a) },
    extractionConfig: { findFirst: (...a: unknown[]) => mockConfigFindFirst(...a) },
  },
}));
vi.mock('@/lib/admin-guard', () => ({ requireAdminApi: () => mockRequireAdmin() }));
vi.mock('@/lib/redis', () => ({
  get redis() {
    return redisHolder.redis;
  },
}));

import { POST } from './route';

function ctx(id = 'c1') {
  return { params: Promise.resolve({ id }) };
}
function req() {
  return new NextRequest('http://localhost/x', { method: 'POST' });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(null);
  mockConfigFindFirst.mockResolvedValue({ publicBaseUrl: 'https://flights.example' });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
  redisHolder.redis = null; // throttle disabled by default
});
afterEach(() => {
  vi.unstubAllGlobals();
  redisHolder.redis = null;
});

describe('POST /api/admin/notifications/[id]/test', () => {
  it('sends a test message through the channel', async () => {
    mockChannelFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encryptSecret('tok'), chatId: '42' } });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when the channel send fails', async () => {
    mockChannelFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encryptSecret('tok'), chatId: '42' } });
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(502);
  });

  it('returns 404 for a missing channel', async () => {
    mockChannelFindFirst.mockResolvedValue(null);
    const res = await POST(req(), ctx('nope'));
    expect(res.status).toBe(404);
  });

  it('blocks a non-admin caller', async () => {
    mockRequireAdmin.mockResolvedValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect(mockChannelFindFirst).not.toHaveBeenCalled();
  });

  it('throttles a repeat send when the reservation is already held', async () => {
    redisHolder.redis = { set: mockRedisSet };
    mockRedisSet.mockResolvedValue(null); // NX failed: key already set
    mockChannelFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encryptSecret('tok'), chatId: '42' } });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed and denies the send when the rate limiter errors', async () => {
    redisHolder.redis = { set: mockRedisSet };
    mockRedisSet.mockRejectedValue(new Error('redis down'));
    mockChannelFindFirst.mockResolvedValue({ id: 'c1', type: 'telegram', config: { botToken: encryptSecret('tok'), chatId: '42' } });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
