/**
 * Tests for POST /api/preview: admission cap (audit D2), deferred
 * cleanup on the request path (audit B4), and the existing request
 * hash deduplication. The route's actual runner work is delegated to
 * runPreviewInBackground; here we just verify the gate logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockFindFirst,
  mockCreate,
  mockCount,
  mockDeleteMany,
  mockUpdateMany,
  mockRunPreview,
  mockValidatePreviewPayload,
  mockUpdate,
  mockExtractionConfigFindFirst,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockCount: vi.fn(),
  mockDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockUpdate: vi.fn().mockResolvedValue({}),
  mockRunPreview: vi.fn().mockResolvedValue({ routes: [] }),
  mockValidatePreviewPayload: vi.fn().mockReturnValue({ origins: [], destinations: [], isOneWay: false }),
  mockExtractionConfigFindFirst: vi.fn().mockResolvedValue({ previewMaxCombos: 24 }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    previewRun: {
      findFirst: mockFindFirst,
      create: mockCreate,
      count: mockCount,
      deleteMany: mockDeleteMany,
      updateMany: mockUpdateMany,
      update: mockUpdate,
    },
    extractionConfig: {
      findFirst: mockExtractionConfigFindFirst,
    },
  },
}));

vi.mock('@/lib/preview-runner', () => ({
  runPreview: mockRunPreview,
  validatePreviewPayload: mockValidatePreviewPayload,
}));

import { POST } from './route';

function makeRequest(body: unknown, ip = '203.0.113.10'): NextRequest {
  return new NextRequest('http://localhost/api/preview', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  });
}

const validBody = {
  origins: [{ code: 'JFK', name: 'New York' }],
  destinations: [{ code: 'LAX', name: 'Los Angeles' }],
  dateFrom: '2026-11-09',
  dateTo: '2026-11-09',
  tripType: 'one_way',
  cabinClass: 'economy',
};

beforeEach(() => {
  mockFindFirst.mockReset();
  mockCreate.mockReset();
  mockCount.mockReset();
  mockDeleteMany.mockClear();
  mockUpdateMany.mockClear();
  mockUpdate.mockClear();
  mockRunPreview.mockClear();
  mockValidatePreviewPayload.mockReset();
  mockValidatePreviewPayload.mockReturnValue({ origins: [], destinations: [], isOneWay: false });

  mockFindFirst.mockResolvedValue(null);
  mockCount.mockResolvedValue(0);
  mockCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'pr-1', expiresAt: new Date(Date.now() + 86_400_000), status: data.status, ...data }),
  );
});

describe('POST /api/preview admission cap (audit D2)', () => {
  it('rejects with 429 when the IP is at the admission cap', async () => {
    mockCount.mockResolvedValue(3); // cap is 3 by default

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Too many active previews/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('admits when the IP count is below the cap', async () => {
    mockCount.mockResolvedValue(2);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(202);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('persists the clientIp on the new preview row', async () => {
    mockCount.mockResolvedValue(0);

    await POST(makeRequest(validBody, '198.51.100.55'));

    const createCall = mockCreate.mock.calls[0]![0] as { data: { clientIp?: string } };
    expect(createCall.data.clientIp).toBe('198.51.100.55');
  });

  it('uses the first hop of x-forwarded-for as the client IP', async () => {
    mockCount.mockResolvedValue(0);
    const req = new NextRequest('http://localhost/api/preview', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10, 10.0.0.1, 192.168.1.1' },
    });

    await POST(req);

    const createCall = mockCreate.mock.calls[0]![0] as { data: { clientIp?: string } };
    expect(createCall.data.clientIp).toBe('203.0.113.10');
  });

  it('counts active previews filtered by clientIp, ACTIVE statuses, and fresh updatedAt', async () => {
    mockCount.mockResolvedValue(0);

    await POST(makeRequest(validBody, '203.0.113.42'));

    expect(mockCount).toHaveBeenCalledTimes(1);
    const where = mockCount.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.clientIp).toBe('203.0.113.42');
    expect(where.status).toEqual({ in: ['pending', 'running'] });
    const updatedAtFilter = where.updatedAt as { gte: Date };
    expect(updatedAtFilter.gte).toBeInstanceOf(Date);
    // Should be within the active window (now - 30 min).
    expect(updatedAtFilter.gte.getTime()).toBeGreaterThan(Date.now() - 31 * 60 * 1000);
  });

  it('skips the admission count when x-forwarded-for is absent (unknown IP)', async () => {
    const req = new NextRequest('http://localhost/api/preview', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);

    expect(res.status).toBe(202);
    expect(mockCount).not.toHaveBeenCalled();
  });
});

describe('POST /api/preview deferred cleanup (audit B4)', () => {
  it('does not await cleanupExpiredPreviewRuns or markStalePreviewRunsFailed', async () => {
    // Make both sweeps hang. If POST awaited them, the await would
    // never resolve. With deferred (void) calls, POST returns 202
    // promptly.
    const pending: Array<() => void> = [];
    mockDeleteMany.mockImplementation(() => new Promise<{ count: number }>((resolve) => {
      pending.push(() => resolve({ count: 0 }));
    }));
    mockUpdateMany.mockImplementation(() => new Promise<{ count: number }>((resolve) => {
      pending.push(() => resolve({ count: 0 }));
    }));
    mockCount.mockResolvedValue(0);

    const res = await Promise.race([
      POST(makeRequest(validBody)),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('POST hung waiting on cleanup')), 500)),
    ]);

    expect((res as Response).status).toBe(202);

    // Drain the deferred work so vitest does not hang on it.
    pending.forEach((resolve) => resolve());
  });
});

describe('POST /api/preview request hash dedup (regression)', () => {
  it('returns existing previewRunId if same hash is already active', async () => {
    const existing = {
      id: 'pr-existing',
      status: 'running',
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    mockFindFirst.mockResolvedValue(existing);

    const res = await POST(makeRequest(validBody));
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.data.previewRunId).toBe('pr-existing');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
