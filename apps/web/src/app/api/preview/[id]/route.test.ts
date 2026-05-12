import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PREVIEW_ACTIVE_TIMEOUT_MS, PREVIEW_TIMEOUT_ERROR } from '@/lib/preview-run';

const { mockFindUnique, mockUpdateMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    previewRun: {
      findUnique: mockFindUnique,
      updateMany: mockUpdateMany,
    },
  },
}));

import { GET } from './route';

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function row(overrides: Record<string, unknown>) {
  return {
    id: 'p1',
    status: 'running',
    resultPayload: null,
    error: null,
    expiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('GET /api/preview/[id]', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockUpdateMany.mockReset();
  });

  it('returns 404 when no row exists', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await GET(new Request('http://test'), makeContext('missing'));
    expect(res.status).toBe(404);
  });

  it('returns the row without touching updateMany when updatedAt is recent', async () => {
    mockFindUnique.mockResolvedValue(row({ status: 'running', updatedAt: new Date() }));
    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(200);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.status).toBe('running');
  });

  it('marks a stale running row failed when updateMany hits (count > 0)', async () => {
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    mockFindUnique
      .mockResolvedValueOnce(row({ status: 'running', updatedAt: stale }))
      .mockResolvedValueOnce(row({ status: 'failed', error: PREVIEW_TIMEOUT_ERROR, updatedAt: new Date() }));
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toBe(PREVIEW_TIMEOUT_ERROR);
  });

  it('updateMany where clause includes status and updatedAt guards (race fix)', async () => {
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    mockFindUnique
      .mockResolvedValueOnce(row({ status: 'running', updatedAt: stale }))
      .mockResolvedValueOnce(row({ status: 'failed', updatedAt: new Date() }));
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await GET(new Request('http://test'), makeContext('p1'));

    const call = mockUpdateMany.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(call.where.id).toBe('p1');
    expect(call.where.status).toEqual({ in: ['pending', 'running'] });
    const updatedAtFilter = call.where.updatedAt as { lt: Date };
    expect(updatedAtFilter.lt).toBeInstanceOf(Date);
    expect(updatedAtFilter.lt.getTime()).toBeLessThanOrEqual(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS);
    expect(call.data).toEqual({ status: 'failed', error: PREVIEW_TIMEOUT_ERROR });
  });

  it('preserves background completion when updateMany no-ops (race winner is background)', async () => {
    // Sequence simulates: GET reads running+stale, background flips row to
    // completed before updateMany runs, updateMany affects 0 rows because
    // the status no longer matches the where clause, refetch returns
    // completed. The race fix should surface completed to the client.
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    const completedResult = { routes: [{ origin: 'JFK', destination: 'LAX', flights: [] }] };
    mockFindUnique
      .mockResolvedValueOnce(row({ status: 'running', updatedAt: stale }))
      .mockResolvedValueOnce(row({
        status: 'completed',
        resultPayload: completedResult,
        updatedAt: new Date(),
      }));
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');
    expect(body.data.result).toEqual(completedResult);
  });

  it('returns 404 when row vanishes between updateMany and refetch', async () => {
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    mockFindUnique
      .mockResolvedValueOnce(row({ status: 'running', updatedAt: stale }))
      .mockResolvedValueOnce(null);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when terminal row has expired', async () => {
    mockFindUnique.mockResolvedValue(row({
      status: 'completed',
      expiresAt: new Date(Date.now() - 1000),
    }));
    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(404);
  });

  it('does not call updateMany for a terminal row even when expired', async () => {
    mockFindUnique.mockResolvedValue(row({
      status: 'failed',
      expiresAt: new Date(Date.now() - 1000),
      updatedAt: new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 10_000),
    }));
    await GET(new Request('http://test'), makeContext('p1'));
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

/**
 * Codex audit C2: white box mock assertions only proved the where shape,
 * not the actual semantics. This describe replaces the mocks with an in
 * memory fake store that applies the actual where-clause filter, then
 * simulates a concurrent background completion landing between the GET
 * handler's findUnique and its updateMany. The completed state must
 * survive.
 */
describe('GET /api/preview/[id] race semantics (audit C2)', () => {
  interface Row {
    id: string;
    status: string;
    resultPayload: unknown;
    error: string | null;
    expiresAt: Date;
    updatedAt: Date;
  }

  type Filter = Record<string, unknown>;

  function matchesWhere(r: Row, where: Filter): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'id') {
        if (r.id !== value) return false;
        continue;
      }
      if (key === 'status') {
        const cond = value as { in?: string[] };
        if (cond.in && !cond.in.includes(r.status)) return false;
        continue;
      }
      if (key === 'updatedAt') {
        const cond = value as { lt?: Date; gte?: Date };
        if (cond.lt && !(r.updatedAt < cond.lt)) return false;
        if (cond.gte && !(r.updatedAt >= cond.gte)) return false;
        continue;
      }
    }
    return true;
  }

  let store: Map<string, Row>;
  let beforeUpdateMany: (() => void) | null = null;

  beforeEach(() => {
    store = new Map();
    beforeUpdateMany = null;
    mockFindUnique.mockReset();
    mockUpdateMany.mockReset();

    mockFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const r = store.get(where.id);
      return r ? { ...r } : null;
    });

    mockUpdateMany.mockImplementation(async ({ where, data }: { where: Filter; data: Filter }) => {
      // Hook: simulate a concurrent write landing between findUnique
      // and updateMany.
      beforeUpdateMany?.();
      let count = 0;
      for (const r of store.values()) {
        if (matchesWhere(r, where)) {
          Object.assign(r, data, { updatedAt: new Date() });
          count++;
        }
      }
      return { count };
    });
  });

  it('background completion between findUnique and updateMany survives the stale marker', async () => {
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    const completedResult = { routes: [{ origin: 'JFK', destination: 'LAX', flights: [] }] };
    store.set('p1', {
      id: 'p1',
      status: 'running',
      resultPayload: null,
      error: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: stale,
    });

    // Hook: just before updateMany runs, the background task writes
    // status=completed. This is the exact race window the audit
    // identified.
    beforeUpdateMany = () => {
      const r = store.get('p1')!;
      r.status = 'completed';
      r.resultPayload = completedResult;
      r.updatedAt = new Date();
    };

    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');
    expect(body.data.result).toEqual(completedResult);
    // The terminal state is preserved in the store.
    expect(store.get('p1')!.status).toBe('completed');
  });

  it('genuinely stale running row is flipped to failed by the store', async () => {
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    store.set('p1', {
      id: 'p1',
      status: 'running',
      resultPayload: null,
      error: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: stale,
    });

    const res = await GET(new Request('http://test'), makeContext('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toBe(PREVIEW_TIMEOUT_ERROR);
    expect(store.get('p1')!.status).toBe('failed');
  });

  it('two concurrent stale GETs both see the failed state but only one actually wrote', async () => {
    const stale = new Date(Date.now() - PREVIEW_ACTIVE_TIMEOUT_MS - 1000);
    store.set('p1', {
      id: 'p1',
      status: 'running',
      resultPayload: null,
      error: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: stale,
    });

    let writeCount = 0;
    const orig = mockUpdateMany.getMockImplementation()!;
    mockUpdateMany.mockImplementation(async (...args) => {
      const r = await orig(...args);
      if ((r as { count: number }).count > 0) writeCount += (r as { count: number }).count;
      return r;
    });

    const [r1, r2] = await Promise.all([
      GET(new Request('http://test'), makeContext('p1')),
      GET(new Request('http://test'), makeContext('p1')),
    ]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1.data.status).toBe('failed');
    expect(b2.data.status).toBe('failed');
    // First call writes count=1; second call's where clause no longer
    // matches because status is already failed, so count=0. Total
    // observed writes equals 1.
    expect(writeCount).toBe(1);
  });
});
