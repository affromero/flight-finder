/**
 * Tests for POST /api/preview: the per IP admission cap (audit findings
 * D2/B/F), deferred cleanup on the request path (audit B4), and the existing
 * request hash deduplication. The route's actual runner work is delegated to
 * runPreviewInBackground; here we just verify the gate logic.
 *
 * Admission is now Redis only and fails CLOSED: the route always consults
 * acquirePreviewAdmission (including for the shared 'unknown' bucket), and any
 * Redis problem surfaces as 'rejected' rather than a non atomic DB count
 * fallback. The DB count gate is gone, so there is no previewRun.count mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockFindFirst,
  mockCreate,
  mockDeleteMany,
  mockUpdateMany,
  mockRunPreview,
  mockValidatePreviewPayload,
  mockUpdate,
  mockExtractionConfigFindFirst,
  mockAcquireAdmission,
  mockReleaseAdmission,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockUpdate: vi.fn().mockResolvedValue({}),
  mockRunPreview: vi.fn().mockResolvedValue({ routes: [] }),
  mockValidatePreviewPayload: vi.fn().mockReturnValue({ origins: [], destinations: [], isOneWay: false }),
  mockExtractionConfigFindFirst: vi.fn().mockResolvedValue({ previewMaxCombos: 24 }),
  mockAcquireAdmission: vi.fn(),
  mockReleaseAdmission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    previewRun: {
      findFirst: mockFindFirst,
      create: mockCreate,
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
  acquirePreviewAdmission: mockAcquireAdmission,
  releasePreviewAdmission: mockReleaseAdmission,
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

const originalTrustedForwardedFor = process.env.TRUSTED_FORWARDED_FOR;

beforeEach(() => {
  mockFindFirst.mockReset();
  mockCreate.mockReset();
  mockDeleteMany.mockClear();
  mockUpdateMany.mockClear();
  mockUpdate.mockClear();
  mockRunPreview.mockClear();
  mockValidatePreviewPayload.mockReset();
  mockValidatePreviewPayload.mockReturnValue({ origins: [], destinations: [], isOneWay: false });
  mockAcquireAdmission.mockReset();
  mockReleaseAdmission.mockClear();
  mockExtractionConfigFindFirst.mockReset();
  mockExtractionConfigFindFirst.mockResolvedValue({ previewMaxCombos: 24 });

  mockFindFirst.mockResolvedValue(null);
  // Default to the happy path: the atomic Redis gate admits. Individual tests
  // override to 'rejected' to assert the cap and the fail-closed behavior.
  mockAcquireAdmission.mockResolvedValue('admitted');
  mockCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'pr-1', expiresAt: new Date(Date.now() + 86_400_000), status: data.status, ...data }),
  );
});

afterEach(() => {
  if (originalTrustedForwardedFor === undefined) {
    delete process.env.TRUSTED_FORWARDED_FOR;
  } else {
    process.env.TRUSTED_FORWARDED_FOR = originalTrustedForwardedFor;
  }
});

describe('POST /api/preview admission cap (audit D2)', () => {
  it('rejects with 429 when the atomic gate is at the cap', async () => {
    mockAcquireAdmission.mockResolvedValue('rejected');

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Too many active previews/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('admits when the gate reserves a slot', async () => {
    mockAcquireAdmission.mockResolvedValue('admitted');

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(202);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('persists the clientIp on the new preview row', async () => {
    await POST(makeRequest(validBody, '198.51.100.55'));

    const createCall = mockCreate.mock.calls[0]![0] as { data: { clientIp?: string } };
    expect(createCall.data.clientIp).toBe('198.51.100.55');
  });

  it('uses the first hop of x-forwarded-for as the client IP and the admission key', async () => {
    const req = new NextRequest('http://localhost/api/preview', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10, 10.0.0.1, 192.168.1.1' },
    });

    await POST(req);

    const createCall = mockCreate.mock.calls[0]![0] as { data: { clientIp?: string } };
    expect(createCall.data.clientIp).toBe('203.0.113.10');
    // The gate keys on the same first-hop IP, not the spoofable downstream hops.
    expect(mockAcquireAdmission).toHaveBeenCalledWith('203.0.113.10', 3);
  });
});

describe('POST /api/preview atomic admission gate (audit M5 TOCTOU)', () => {
  it('rejects with 429 when the atomic Redis gate is at the cap, without ever reaching create', async () => {
    mockAcquireAdmission.mockResolvedValue('rejected');

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Too many active previews/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('consults the atomic gate with the configured admission cap', async () => {
    mockExtractionConfigFindFirst.mockResolvedValue({ previewMaxCombos: 24, previewAdmissionCap: 5 });
    mockAcquireAdmission.mockResolvedValue('admitted');

    await POST(makeRequest(validBody, '203.0.113.99'));

    expect(mockAcquireAdmission).toHaveBeenCalledWith('203.0.113.99', 5);
  });

  it('admits via the atomic gate', async () => {
    mockAcquireAdmission.mockResolvedValue('admitted');

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(202);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('simulates a concurrent burst: only requests the atomic gate admits create rows', async () => {
    // Model an INCR-backed counter that the route's gate would consult. The
    // gate hands out at most `cap` admissions across a concurrent burst; the
    // rest get 'rejected'. We assert exactly `cap` create calls happen.
    const cap = 3;
    let inFlight = 0;
    mockAcquireAdmission.mockImplementation(async () => {
      // Each concurrent invocation observes the post-increment value, the
      // way a single-threaded Redis INCR would.
      const current = ++inFlight;
      if (current > cap) {
        inFlight--; // mirror the route helper's DECR-on-overshoot
        return 'rejected';
      }
      return 'admitted';
    });

    const requests = Array.from({ length: 8 }, () => POST(makeRequest(validBody)));
    const responses = await Promise.all(requests);

    const admitted = responses.filter((r) => r.status === 202);
    const rejected = responses.filter((r) => r.status === 429);
    expect(admitted).toHaveLength(cap);
    expect(rejected).toHaveLength(8 - cap);
    expect(mockCreate).toHaveBeenCalledTimes(cap);
  });

  it('releases the admission slot when create throws after a successful admission', async () => {
    mockAcquireAdmission.mockResolvedValue('admitted');
    mockCreate.mockRejectedValue(new Error('db write failed'));

    await expect(POST(makeRequest(validBody, '198.51.100.7'))).rejects.toThrow('db write failed');

    expect(mockReleaseAdmission).toHaveBeenCalledWith('198.51.100.7');
  });
});

describe('POST /api/preview unknown bucket is gated (audit finding B)', () => {
  it('runs the admission gate for the shared unknown bucket when no trusted proxy is asserted', async () => {
    // TRUSTED_FORWARDED_FOR=false collapses every caller to the 'unknown'
    // bucket. The gate MUST still run, otherwise omitting the header bypasses
    // the cap entirely.
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    mockAcquireAdmission.mockResolvedValue('admitted');

    const req = new NextRequest('http://localhost/api/preview', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    });

    const res = await POST(req);

    expect(res.status).toBe(202);
    // All untrusted callers share one bucket: the key is the constant 'unknown'
    // regardless of whatever x-forwarded-for they supply.
    expect(mockAcquireAdmission).toHaveBeenCalledWith('unknown', 3);
  });

  it('rejects with 429 once the shared unknown bucket hits the cap', async () => {
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    mockAcquireAdmission.mockResolvedValue('rejected');

    const req = new NextRequest('http://localhost/api/preview', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(mockAcquireAdmission).toHaveBeenCalledWith('unknown', 3);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a rotated x-forwarded-for cannot mint fresh buckets to bypass the cap', async () => {
    // With no trusted proxy, every spoofed header collapses to 'unknown', so a
    // burst that rotates the header still contends for the same capped bucket.
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    const cap = 2;
    let inFlight = 0;
    mockAcquireAdmission.mockImplementation(async (ip: string) => {
      expect(ip).toBe('unknown'); // every rotated header lands in one bucket
      const current = ++inFlight;
      if (current > cap) {
        inFlight--;
        return 'rejected';
      }
      return 'admitted';
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        POST(new NextRequest('http://localhost/api/preview', {
          method: 'POST',
          body: JSON.stringify(validBody),
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${i}` },
        })),
      ),
    );

    const admitted = responses.filter((r) => r.status === 202);
    expect(admitted).toHaveLength(cap);
    expect(mockCreate).toHaveBeenCalledTimes(cap);
  });
});

describe('POST /api/preview fails closed when Redis is unavailable (audit finding F)', () => {
  it('returns 429 (denies admission) rather than admitting via a DB count', async () => {
    // acquirePreviewAdmission returns 'rejected' for any Redis problem (not
    // configured or errored). The route must NOT create a run, and there is no
    // DB-count fallback to reopen the TOCTOU race.
    mockAcquireAdmission.mockResolvedValue('rejected');

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Too many active previews/i);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockReleaseAdmission).not.toHaveBeenCalled();
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
    mockAcquireAdmission.mockResolvedValue('admitted');

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
