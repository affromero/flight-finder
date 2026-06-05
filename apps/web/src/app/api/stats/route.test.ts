import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryCount, mockFetchRunCount, mockSnapshotCount, mockAggregate, mockGetSessionToken, mockVerifySessionToken } =
  vi.hoisted(() => ({
    mockQueryCount: vi.fn(),
    mockFetchRunCount: vi.fn(),
    mockSnapshotCount: vi.fn(),
    mockAggregate: vi.fn(),
    mockGetSessionToken: vi.fn(),
    mockVerifySessionToken: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
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

vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: () => mockGetSessionToken(),
  verifySessionToken: (token: string) => mockVerifySessionToken(token),
  parseAdminTokenTimestamp: () => 1000,
}));

import { GET } from './route';

function setupCounts() {
  mockQueryCount.mockResolvedValue(7);
  mockFetchRunCount.mockResolvedValue(42);
  mockSnapshotCount.mockResolvedValue(1234);
  mockAggregate.mockResolvedValue({ _sum: { costUsd: 1.23 } });
}

describe('GET /api/stats -- unauthenticated caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCounts();
    mockGetSessionToken.mockResolvedValue(null);
    mockVerifySessionToken.mockReturnValue(false);
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
  beforeEach(() => {
    vi.clearAllMocks();
    setupCounts();
    mockGetSessionToken.mockResolvedValue('admin:12345.validsig');
    mockVerifySessionToken.mockReturnValue(true);
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
    mockAggregate.mockResolvedValue({ _sum: { costUsd: 1.999999 } });
    const res = await GET();
    const body = await res.json();
    expect(body.data.llmCost30d).toBe(2);
  });

  it('returns 0 when no cost rows exist', async () => {
    mockAggregate.mockResolvedValue({ _sum: { costUsd: null } });
    const res = await GET();
    const body = await res.json();
    expect(body.data.llmCost30d).toBe(0);
  });
});
