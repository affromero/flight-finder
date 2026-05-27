import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: { query: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/multi-user', () => ({ isMultiUserEnabled: () => mockIsMultiUserEnabled() }));
vi.mock('@/lib/user-auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

import { GET } from './route';

function shapedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    active: true,
    origin: 'JFK',
    destination: 'LAX',
    originName: 'New York',
    destinationName: 'Los Angeles',
    dateFrom: new Date('2026-06-10'),
    dateTo: new Date('2026-06-17'),
    scrapeInterval: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    expiresAt: new Date('2026-08-01T00:00:00Z'),
    groupId: null,
    label: null,
    preferredAggregators: [],
    fetchRuns: [],
    _count: { snapshots: 0 },
    ...overrides,
  };
}

describe('GET /api/queries/active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('surfaces lastScrapeStatus and lastScrapeError on success', async () => {
    mockFindMany.mockResolvedValue([
      shapedRow({
        fetchRuns: [
          {
            startedAt: new Date('2026-05-20T12:00:00Z'),
            status: 'success',
            error: null,
          },
        ],
      }),
    ]);
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.queries[0]).toMatchObject({
      lastScrapeStatus: 'success',
      lastScrapeError: null,
    });
  });

  it('surfaces lastScrapeStatus=failed plus the error message', async () => {
    mockFindMany.mockResolvedValue([
      shapedRow({
        fetchRuns: [
          {
            startedAt: new Date('2026-05-20T12:00:00Z'),
            status: 'failed',
            error: 'LLM response contained no parseable JSON array.',
          },
        ],
      }),
    ]);
    const res = await GET();
    const data = await res.json();
    expect(data.data.queries[0]).toMatchObject({
      lastScrapeStatus: 'failed',
      lastScrapeError: 'LLM response contained no parseable JSON array.',
    });
  });

  it('returns null status/error when the query has no fetchRuns yet', async () => {
    mockFindMany.mockResolvedValue([shapedRow({ fetchRuns: [] })]);
    const res = await GET();
    const data = await res.json();
    expect(data.data.queries[0]).toMatchObject({
      lastScrapeStatus: null,
      lastScrapeError: null,
      lastScrapedAt: null,
    });
  });
});
