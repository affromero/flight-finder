import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQueryFindUnique = vi.fn();
const mockQueryFindMany = vi.fn();
const mockFetchRunCreate = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: {
      findUnique: (...args: unknown[]) => mockQueryFindUnique(...args),
      findMany: (...args: unknown[]) => mockQueryFindMany(...args),
    },
    fetchRun: {
      create: (...args: unknown[]) => mockFetchRunCreate(...args),
    },
  },
}));

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/multi-user', () => ({ isMultiUserEnabled: () => mockIsMultiUserEnabled() }));
vi.mock('@/lib/user-auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

const mockGetSessionToken = vi.fn().mockResolvedValue(undefined);
const mockVerifySessionToken = vi.fn().mockReturnValue(false);
vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: () => mockGetSessionToken(),
  verifySessionToken: (token: string) => mockVerifySessionToken(token),
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

describe('POST /api/queries/[id]/scrape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunFullScrapeForQuery.mockResolvedValue([]);
    mockRedisRef.current = { set: mockRedisSet };
    mockRedisSet.mockResolvedValue('OK');
    mockFetchRunCreate.mockImplementation(({ data }: { data: { queryId: string } }) =>
      Promise.resolve({ id: `fr_${data.queryId}`, queryId: data.queryId }),
    );
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
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: false,
    });
    const res = await POST(...makeRequest('q1', {}));
    expect(res.status).toBe(401);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 403 in hosted mode with a wrong token', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: false,
    });
    const res = await POST(...makeRequest('q1', { deleteToken: 'nope' }));
    expect(res.status).toBe(403);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 409 on a paused tracker', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: false, isSeed: false,
    });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.error).toContain('paused');
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('returns 409 on a seed query', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: true,
    });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(409);
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('hosted mode + valid token: fires once, pre-creates one FetchRun row, returns accepted', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: false,
    });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toMatchObject({ accepted: true, count: 1, groupId: null });
    expect(mockFetchRunCreate).toHaveBeenCalledTimes(1);
    expect(mockFetchRunCreate).toHaveBeenCalledWith({
      data: { queryId: 'q1', status: 'in_progress', source: 'manual' },
      select: { id: true, queryId: true },
    });
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledWith('q1', { fetchRunId: 'fr_q1' });
  });

  it('cascades across siblings in serial when the row has a groupId', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: 'g1', userId: null, active: true, isSeed: false,
    });
    mockQueryFindMany.mockResolvedValue([
      { id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' },
    ]);
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toMatchObject({ accepted: true, count: 4, groupId: 'g1' });
    expect(mockFetchRunCreate).toHaveBeenCalledTimes(4);
    // Run a few microtasks so the IIFE can reach every sibling.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(4);
    expect(mockRunFullScrapeForQuery.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('returns 429 when Redis says the throttle key already exists', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: 'g1', userId: null, active: true, isSeed: false,
    });
    mockQueryFindMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }]);
    mockRedisSet.mockResolvedValueOnce(null);
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(429);
    expect(mockFetchRunCreate).not.toHaveBeenCalled();
    expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
  });

  it('continues when Redis throws (graceful degrade)', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: false,
    });
    mockRedisSet.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    expect(res.status).toBe(200);
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
  });

  it('continues when Redis is disabled (redis === null)', async () => {
    mockRedisRef.current = null;
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: false,
    });
    const res = await POST(...makeRequest('q1', { deleteToken: 'real-token' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.throttledUntil).toBeNull();
    await flushIifeMicrotasks();
    expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
  });

  it('hosted mode legacy admin session authorises without a token', async () => {
    mockQueryFindUnique.mockResolvedValue({
      deleteToken: 'real-token', groupId: null, userId: null, active: true, isSeed: false,
    });
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
      mockQueryFindUnique.mockResolvedValue({
        deleteToken: 'real-token', groupId: null, userId: 'someone_else', active: true, isSeed: false,
      });
      const res = await POST(...makeRequest('q1', {}));
      expect(res.status).toBe(200);
      await flushIifeMicrotasks();
      expect(mockRunFullScrapeForQuery).toHaveBeenCalledTimes(1);
    });

    it('owner user passes', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user_1', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue({
        deleteToken: 'real-token', groupId: null, userId: 'user_1', active: true, isSeed: false,
      });
      const res = await POST(...makeRequest('q1', {}));
      expect(res.status).toBe(200);
    });

    it('non owner non admin gets 403', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user_2', isAdmin: false });
      mockQueryFindUnique.mockResolvedValue({
        deleteToken: 'real-token', groupId: null, userId: 'user_1', active: true, isSeed: false,
      });
      const res = await POST(...makeRequest('q1', {}));
      expect(res.status).toBe(403);
      expect(mockRunFullScrapeForQuery).not.toHaveBeenCalled();
    });
  });
});
