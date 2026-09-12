import { describe, it, expect, vi } from 'vitest';

const { mockQueryRaw, mockQueryCount, mockRedis } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockQueryCount: vi.fn(),
  mockRedis: { ping: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    query: { count: (...args: unknown[]) => mockQueryCount(...args) },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: mockRedis,
}));

vi.mock('@/lib/cron', () => ({
  getCronInfo: () => ({
    intervalHours: 3,
    jitterSeconds: null,
    nextScrape: null,
    lastScrape: null,
  }),
}));

import { GET } from './route';

describe('GET /api/health', () => {
  it('returns ok when db and redis connected', async () => {
    mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
    mockRedis.ping.mockResolvedValue('PONG');
    mockQueryCount.mockResolvedValue(5);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.application).toBe('flight-finder');
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.redis).toBe('connected');
    expect(body.activeQueries).toBe(5);
  });

  it('returns degraded 503 when db fails', async () => {
    mockQueryRaw.mockRejectedValue(new Error('connection refused'));
    mockRedis.ping.mockResolvedValue('PONG');
    mockQueryCount.mockResolvedValue(0);

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('error');
  });

  it('returns degraded 503 when redis fails', async () => {
    mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
    mockRedis.ping.mockRejectedValue(new Error('redis down'));
    mockQueryCount.mockResolvedValue(0);

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.redis).toBe('error');
  });

  it('includes active query count', async () => {
    mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
    mockRedis.ping.mockResolvedValue('PONG');
    mockQueryCount.mockResolvedValue(42);

    const res = await GET();
    const body = await res.json();
    expect(body.activeQueries).toBe(42);
  });

  it('includes cron info', async () => {
    mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
    mockRedis.ping.mockResolvedValue('PONG');
    mockQueryCount.mockResolvedValue(0);

    const res = await GET();
    const body = await res.json();
    expect(body.cron).toBeDefined();
    expect(body.cron.intervalHours).toBe(3);
  });
});
