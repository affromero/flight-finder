import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockQueryFindUnique,
  mockQueryFindMany,
  mockFetchRunCreate,
  mockFetchRunFindFirst,
  mockFetchRunUpdate,
  mockExtractionFindFirst,
} = vi.hoisted(() => ({
  mockQueryFindUnique: vi.fn(),
  mockQueryFindMany: vi.fn(),
  mockFetchRunCreate: vi.fn(),
  mockFetchRunFindFirst: vi.fn(),
  mockFetchRunUpdate: vi.fn(),
  mockExtractionFindFirst: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const txClient = {
    query: {
      findUnique: (...args: unknown[]) => mockQueryFindUnique(...args),
      findMany: (...args: unknown[]) => mockQueryFindMany(...args),
    },
    fetchRun: {
      create: (...args: unknown[]) => mockFetchRunCreate(...args),
      findFirst: (...args: unknown[]) => mockFetchRunFindFirst(...args),
      update: (...args: unknown[]) => mockFetchRunUpdate(...args),
    },
    extractionConfig: {
      findFirst: (...args: unknown[]) => mockExtractionFindFirst(...args),
      findUnique: async () => null,
    },
  };
  return {
    prisma: {
      ...txClient,
      $transaction: async (
        cb: (tx: typeof txClient) => Promise<unknown>,
        _opts?: unknown,
      ) => cb(txClient),
    },
  };
});

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/multi-user', () => ({ isMultiUserEnabled: () => mockIsMultiUserEnabled() }));
vi.mock('@/lib/user-auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

const mockGetSessionToken = vi.fn().mockResolvedValue(undefined);
const mockVerifySessionToken = vi.fn().mockReturnValue(false);
vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: () => mockGetSessionToken(),
  verifySessionToken: (token: string) => mockVerifySessionToken(token),
  parseAdminTokenTimestamp: () => 1000,
}));

const mockRedisSet = vi.fn();
const mockRedisRef = { current: { set: mockRedisSet } as { set: typeof mockRedisSet } | null };
vi.mock('@/lib/redis', () => ({
  get redis() {
    return mockRedisRef.current;
  },
}));

const mockRunFullScrapeForQuery = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/scraper/run-scrape', () => ({
  runFullScrapeForQuery: (queryId: string, opts?: { fetchRunId?: string }) =>
    mockRunFullScrapeForQuery(queryId, opts),
}));

import { POST } from './route';

function makeRequest(id: string, body?: Record<string, unknown>): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/queries/${id}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }),
    { params: Promise.resolve({ id }) },
  ];
}

async function flushIifeMicrotasks() {
  // The handler kicks the scrape in a fire-and-forget IIFE. The runs are
  // sequential so a single microtask flush is enough to let the first call
  // appear in the mock; the loop continues on the same tick chain.
  await new Promise((r) => setImmediate(r));
}

const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');
const FAR_PAST = new Date('2000-01-01T00:00:00Z');

function rowDefaults(overrides: Record<string, unknown> = {}) {
  return {
    deleteToken: 'real-token',
    groupId: null,
    userId: null,
    active: true,
    isSeed: false,
    expiresAt: FAR_FUTURE,
    ...overrides,
  };
}

describe('POST /api/queries/[id]/scrape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunFullScrapeForQuery.mockResolvedValue([]);
    mockRedisRef.current = { set: mockRedisSet };
    mockRedisSet.mockResolvedValue('OK');
    mockFetchRunCreate.mockImplementation(({ data }: { data: { queryId: string } }) =>
      Promise.resolve({ id: `fr_${data.queryId}`, queryId: data.queryId }),
    );
    mockFetchRunFindFirst.mockResolvedValue(null);
    mockFetchRunUpdate.mockResolvedValue({});
    mockExtractionFindFirst.mockResolvedValue({ enabled: true });
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    mockGetSessionToken.mockResolvedValue(undefined);
    mockVerifySessionToken.mockReturnValue(false);
    delete process.env.SELF_HOSTED;
  });

  afterEach(() => {
    delete process.env.SELF_HOSTED;
  });

  it('returns 404 when the query does not exist', async () => {
    mockQueryFindUnique.mockResolvedValue(null);
    const res = await POST(...makeRequest('missing', { deleteToken: 'tok' }));
    expect(res.status).toBe(404);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 401 in hosted mode without a token or admin cookie', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    const res = await POST(...makeRequest('q1', {}));
    expect(res.status).toBe(401);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 403 in hosted mode with a wrong token', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    const res = await POST(...makeRequest('q1', { deleteToken: 'nope' }));
    expect(res.status).toBe(403);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 409 on a paused tracker', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults({ active: false }));
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.error).toContain('paused');
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 409 when scraping is globally paused (config.enabled=false)', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    mockExtractionFindFirst.mockResolvedValue({ enabled: false });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.error).toMatch(/paused/i);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 409 on a seed query', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults({ isSeed: true }));
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(409);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 410 on an expired tracker (active but past expiresAt)', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults({ expiresAt: FAR_PAST }));
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(410);
    expect(data.error).toContain('expired');
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 429 when a sibling already has an in_progress FetchRun row', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults({ groupId: 'g1' }));
    mockQueryFindMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
    mockFetchRunFindFirst.mockResolvedValueOnce({ id: 'stuck-run' });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(429);
    expect(data.error).toContain('already running');
    expect(mockFetchRunCreate).not.toHaveBeenCalled();
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('still blocks an in-progress run even when Redis is disabled', async () => {
    mockRedisRef.current = null;
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    mockFetchRunFindFirst.mockResolvedValueOnce({ id: 'stuck-run' });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(429);
    expect(mockFetchRunCreate).not.toHaveBeenCalled();
  });

  it('ignores stale in_progress rows older than the staleness cutoff', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    // No in-progress row younger than the cutoff -> findFirst returns null.
    // We assert the query the endpoint sent includes a startedAt>staleBefore
    // filter so a half-finished crashed run cannot deadlock the group.
    mockFetchRunFindFirst.mockImplementation(({ where }: { where: { startedAt?: { gt?: Date } } }) => {
      expect(where.startedAt?.gt).toBeInstanceOf(Date);
      expect(where.startedAt!.gt!.getTime()).toBeLessThan(Date.now());
      return Promise.resolve(null);
    });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(200);
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
  });

  it('hosted mode + valid token: pre-creates only the primary row, fires once, returns accepted', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toMatchObject({ accepted: true, count: 1, groupId: null });
    expect(mockFetchRunCreate).toHaveBeenCalledTimes(1);
    expect(mockFetchRunCreate).toHaveBeenCalledWith({
      data: { queryId: 'q1', status: 'in_progress', source: 'manual' },
      select: { id: true },
    });
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledWith('q1', { fetchRunId: 'fr_q1' });
  });

  it('cascades across siblings in serial: primary first with reused row, rest without opts', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults({ groupId: 'g1' }));
    mockQueryFindMany.mockResolvedValue([
      { id: 'q2' }, { id: 'q1' }, { id: 'q3' }, { id: 'q4' },
    ]);
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toMatchObject({ accepted: true, count: 4, groupId: 'g1' });
    // Only the primary's row is pre-created. Sibling rows are created
    // inside runScrapeForQuery as the loop reaches them (mocked out here).
    expect(mockFetchRunCreate).toHaveBeenCalledTimes(1);
    expect(mockFetchRunCreate).toHaveBeenCalledWith({
      data: { queryId: 'q1', status: 'in_progress', source: 'manual' },
      select: { id: true },
    });
    // Run microtasks so the serial IIFE can reach every sibling.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(4);
    // Primary runs first and reuses the pre-created row id; the rest pass
    // no opts and let runScrapeForQuery create rows just-in-time.
    expect(mockRunFullScrapeForQuery.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(mockRunFullScrapeForQuery.mock.calls[0]?.[1]).toEqual({ fetchRunId: 'fr_q1' });
    expect(mockRunFullScrapeForQuery.mock.calls[1]?.[1]).toBeUndefined();
  });

  it('returns 429 when Redis says the throttle key already exists', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults({ groupId: 'g1' }));
    mockQueryFindMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
    mockRedisSet.mockResolvedValueOnce(null);
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(429);
    expect(mockFetchRunCreate).not.toHaveBeenCalled();
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('continues when Redis throws (graceful degrade)', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    mockRedisSet.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(200);
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
  });

  it('continues when Redis is disabled (redis === null)', async () => {
    mockRedisRef.current = null;
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.throttledUntil).toBeNull();
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
  });

  it('marks the pre-created primary row failed when runFullScrapeForQuery throws', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    mockRunFullScrapeForQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(200);
    // Let the background IIFE settle.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(mockFetchRunUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'fr_q1' },
      data: expect.objectContaining({ status: 'failed', error: 'boom' }),
    }));
  });

  it('hosted mode legacy admin session authorises without a token', async () => {
    mockQueryFindUnique.mockResolvedValue(rowDefaults());
    mockGetSessionToken.mockResolvedValueOnce('admin:1234.abc');
    mockVerifySessionToken.mockReturnValueOnce(true);
    const res = await POST(...makeRequest('q1', {}));
    expect(res.status).toBe(200);
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
  });

  describe('self hosted multi user mode', () => {
    beforeEach(() => {
      process.env.SELF_HOSTED = 'true';
      mockIsMultiUserEnabled.mockResolvedValue(true);
    });

    it('admin session passes without token', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'admin_1', isAdmin: true });
      mockQueryFindUnique.mockResolvedValue(rowDefaults({ userId: 'someone_else' }));
      const res = await POST(...makeRequest('q1', {}));
      expect(res.status).toBe(200);
      await flushIifeMicrotasks();
      expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
    });

    it('owner user passes', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user_1', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue(rowDefaults({ userId: 'user_1' }));
      const res = await POST(...makeRequest('q1', {}));
      expect(res.status).toBe(200);
    });

    it('non owner non admin gets 403', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user_2', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue(rowDefaults({ userId: 'user_1' }));
      const res = await POST(...makeRequest('q1', {}));
      expect(res.status).toBe(403);
      expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
    });
  });

  describe('completion summary log', () => {
    it('logs a success/failure summary line when the manual run completes', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockQueryFindUnique.mockResolvedValue(rowDefaults({ groupId: 'g1' }));
      mockQueryFindMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
      mockRunFullScrapeForQuery
        .mockResolvedValueOnce([{ queryId: 'q1', status: 'success', snapshotsCount: 3, extractionCost: 0.01 }])
        .mockResolvedValueOnce([{ queryId: 'q2', status: 'failed', snapshotsCount: 0, extractionCost: 0, error: 'oh' }]);

      const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
      expect(res.status).toBe(200);
      for (let i = 0; i < 6; i++) await flushIifeMicrotasks();

      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/manual run complete \(group=g1\): 1 successes, 1 failures/),
      );
      consoleLog.mockRestore();
    });

    it('counts a thrown target as failure in the summary', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockQueryFindUnique.mockResolvedValue(rowDefaults());
      mockRunFullScrapeForQuery.mockRejectedValueOnce(new Error('boom'));

      const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
      expect(res.status).toBe(200);
      for (let i = 0; i < 6; i++) await flushIifeMicrotasks();

      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/manual run complete \(group=q1\): 0 successes, 1 failures/),
      );
      consoleLog.mockRestore();
      consoleErr.mockRestore();
    });

    it('counts an empty results array as failure (no country passes ran)', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockQueryFindUnique.mockResolvedValue(rowDefaults());
      mockRunFullScrapeForQuery.mockResolvedValueOnce([]);

      const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
      expect(res.status).toBe(200);
      for (let i = 0; i < 6; i++) await flushIifeMicrotasks();

      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/manual run complete \(group=q1\): 0 successes, 1 failures/),
      );
      consoleLog.mockRestore();
    });
  });
});
