import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockSnapshotFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: { findMany: (...args: unknown[]) => mockFindMany(...args) },
    priceSnapshot: { findMany: (...args: unknown[]) => mockSnapshotFindMany(...args) },
  },
}));

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/multi-user', () => ({ isMultiUserEnabled: () => mockIsMultiUserEnabled() }));
vi.mock('@/lib/user-auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

import { GET } from './route';

const RUN_A = { id: 'run-a', startedAt: new Date('2026-06-05T10:00:00Z') };
const RUN_B = { id: 'run-b', startedAt: new Date('2026-06-04T10:00:00Z') };

function makeQuery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    origin: 'JFK',
    destination: 'LAX',
    currency: 'USD',
    fetchRuns: [RUN_A, RUN_B],
    ...overrides,
  };
}

describe('GET /api/alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    mockFindMany.mockResolvedValue([]);
    mockSnapshotFindMany.mockResolvedValue([]);
  });

  describe('multi-user mode auth enforcement', () => {
    it('returns 401 for an unauthenticated request when multi-user mode is enabled', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(true);
      mockGetCurrentUser.mockResolvedValue(null);

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.ok).toBe(false);
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('scopes the query to the authenticated user in multi-user mode', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(true);
      mockGetCurrentUser.mockResolvedValue({ id: 'user-42' });
      mockFindMany.mockResolvedValue([]);

      await GET();

      expect(mockFindMany).toHaveBeenCalledOnce();
      const whereClause = mockFindMany.mock.calls[0]![0].where as Record<string, unknown>;
      expect(whereClause.userId).toBe('user-42');
    });

    it('does not include queries from other users in multi-user mode', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(true);
      mockGetCurrentUser.mockResolvedValue({ id: 'user-42' });

      // Return a query that belongs to a different user (the DB would never
      // return it given the userId filter, but we verify the filter is passed).
      mockFindMany.mockResolvedValue([]);

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.alerts).toHaveLength(0);

      const whereClause = mockFindMany.mock.calls[0]![0].where as Record<string, unknown>;
      expect(whereClause.userId).toBe('user-42');
    });
  });

  describe('single-user / public mode', () => {
    it('allows unauthenticated requests when multi-user mode is disabled', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(false);
      mockGetCurrentUser.mockResolvedValue(null);
      mockFindMany.mockResolvedValue([]);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(mockFindMany).toHaveBeenCalledOnce();
      // No userId constraint applied in single-user mode
      const whereClause = mockFindMany.mock.calls[0]![0].where as Record<string, unknown>;
      expect(whereClause.userId).toBeUndefined();
    });
  });

  describe('alert detection', () => {
    it('returns an alert when the current price dropped by $20 or more', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(false);
      mockFindMany.mockResolvedValue([makeQuery()]);
      mockSnapshotFindMany
        .mockResolvedValueOnce([{ price: 180, airline: 'Delta' }])   // current run
        .mockResolvedValueOnce([{ price: 250 }]);                     // previous run

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.alerts).toHaveLength(1);
      expect(body.data.alerts[0]).toMatchObject({
        queryId: 'q1',
        origin: 'JFK',
        destination: 'LAX',
        currentMin: 180,
        previousMin: 250,
        drop: 70,
        airline: 'Delta',
      });
    });

    it('returns no alert when the price drop is below both thresholds', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(false);
      mockFindMany.mockResolvedValue([makeQuery()]);
      mockSnapshotFindMany
        .mockResolvedValueOnce([{ price: 245, airline: 'United' }])
        .mockResolvedValueOnce([{ price: 250 }]);

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.alerts).toHaveLength(0);
    });

    it('returns no alert when there are fewer than two successful fetch runs', async () => {
      mockIsMultiUserEnabled.mockResolvedValue(false);
      mockFindMany.mockResolvedValue([makeQuery({ fetchRuns: [RUN_A] })]);

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.alerts).toHaveLength(0);
      expect(mockSnapshotFindMany).not.toHaveBeenCalled();
    });
  });
});
