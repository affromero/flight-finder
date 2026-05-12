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
