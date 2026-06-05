import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockQueryFindMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    query: {
      findMany: (...args: unknown[]) => mockQueryFindMany(...args),
    },
  },
}));

vi.mock('@/lib/admin-guard', () => ({
  requireAdminApi: vi.fn(() => Promise.resolve(null)),
}));

import { GET } from './route';

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/admin/queries');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

describe('GET /api/admin/queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryFindMany.mockResolvedValue([]);
  });

  it('returns 200 with queries, page, and limit in the response', async () => {
    const queries = [{ id: 'q1', origin: 'JFK', destination: 'LAX' }];
    mockQueryFindMany.mockResolvedValue(queries);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.queries).toHaveLength(1);
    expect(body.data.page).toBe(0);
    expect(body.data.limit).toBe(200);
  });

  it('uses default limit of 200 and passes take + skip to findMany (DB-6 bound)', async () => {
    await GET(makeRequest());
    expect(mockQueryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, skip: 0 }),
    );
  });

  it('respects a custom limit up to the MAX_LIMIT of 500', async () => {
    await GET(makeRequest({ limit: '50' }));
    expect(mockQueryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 0 }),
    );
  });

  it('caps limit at 500 even if a larger value is supplied', async () => {
    await GET(makeRequest({ limit: '9999' }));
    expect(mockQueryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
    const body = await (await GET(makeRequest({ limit: '9999' }))).json();
    expect(body.data.limit).toBe(500);
  });

  it('paginates correctly using page and limit', async () => {
    await GET(makeRequest({ page: '2', limit: '100' }));
    expect(mockQueryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 200 }),
    );
  });

  it('returns 400 for an invalid limit', async () => {
    const res = await GET(makeRequest({ limit: 'abc' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a negative page', async () => {
    const res = await GET(makeRequest({ page: '-1' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for limit of zero', async () => {
    const res = await GET(makeRequest({ limit: '0' }));
    expect(res.status).toBe(400);
  });

  it('blocks unauthenticated requests', async () => {
    const { requireAdminApi } = await import('@/lib/admin-guard');
    vi.mocked(requireAdminApi).mockResolvedValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockQueryFindMany).not.toHaveBeenCalled();
  });
});
