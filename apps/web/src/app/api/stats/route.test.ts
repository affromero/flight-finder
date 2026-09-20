import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { createRequestAccessFixture } from '@/test/access-fixture';
const sessionBoundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createRequestAccessFixture> | null }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createRequestAccessFixture } = await import('@/test/access-fixture');
  const fixture = createRequestAccessFixture(); sessionBoundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => sessionBoundary.fixture?.token ? { value: sessionBoundary.fixture.token } : undefined }) }));
beforeEach(() => sessionBoundary.fixture!.resetRequest());

const { mockQueryCount, mockFetchRunCount, mockSnapshotCount, mockAggregate } =
  vi.hoisted(() => ({
    mockQueryCount: vi.fn(),
    mockFetchRunCount: vi.fn(),
    mockSnapshotCount: vi.fn(),
    mockAggregate: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: async () => sessionBoundary.fixture!.user },
    query: { count: (...args: unknown[]) => mockQueryCount(...args) },
    fetchRun: { count: (...args: unknown[]) => mockFetchRunCount(...args) },
    priceSnapshot: { count: (...args: unknown[]) => mockSnapshotCount(...args) },
    apiUsageLog: { aggregate: (...args: unknown[]) => mockAggregate(...args) },
    extractionConfig: { findUnique: async () => null },
  },
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

function setupCounts() {
  mockQueryCount.mockResolvedValue(7);
  mockFetchRunCount.mockResolvedValue(42);
  mockSnapshotCount.mockResolvedValue(1234);
  mockAggregate.mockResolvedValue({ _sum: { costUsd: 1.23 }, _count: { _all: 2, costUsd: 2 } });
}

describe('GET /api/stats -- unauthenticated caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCounts();
  });

  it('returns public counts', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.activeQueries).toBe(7);
    expect(body.data.totalScrapes).toBe(42);
    expect(body.data.totalPricePoints).toBe(1234);
    expect(body.data.cron).toBeDefined();
  });

  it('omits llmCost30d for unauthenticated callers', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.data).not.toHaveProperty('llmCost30d');
  });
});

describe('GET /api/stats -- authenticated admin', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    setupCounts();
    await sessionBoundary.fixture!.signIn({ id: 'owner', isAdmin: true });
  });

  it('includes llmCost30d for authenticated admins', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.llmCost30d).toBe(1.23);
  });

  it('also includes public counts', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.data.activeQueries).toBe(7);
    expect(body.data.totalScrapes).toBe(42);
    expect(body.data.totalPricePoints).toBe(1234);
  });

  it('rounds cost to two decimal places', async () => {
    mockAggregate.mockResolvedValue({ _sum: { costUsd: 1.999999 }, _count: { _all: 2, costUsd: 2 } });
    const res = await GET();
    const body = await res.json();
    expect(body.data.llmCost30d).toBe(2);
  });

  it('returns 0 when no cost rows exist', async () => {
    mockAggregate.mockResolvedValue({ _sum: { costUsd: null }, _count: { _all: 0, costUsd: 0 } });
    const res = await GET();
    const body = await res.json();
    expect(body.data.llmCost30d).toBe(0);
  });

  it('distinguishes a known subtotal from incomplete monthly cost', async () => {
    mockAggregate.mockResolvedValue({ _sum: { costUsd: 1.23 }, _count: { _all: 3, costUsd: 2 } });
    const body = await (await GET()).json();
    expect(body.data.llmCost30d).toBeNull();
    expect(body.data.llmKnownCost30d).toBe(1.23);
    expect(body.data.llmUnknownCostRows30d).toBe(1);
  });
});
