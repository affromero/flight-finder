import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsert = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

vi.mock('@/lib/admin-guard', () => ({
  requireAdminApi: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/cron', () => ({
  updateCronInterval: vi.fn(),
}));

vi.mock('@/lib/scraper/ai-registry', () => ({
  EXTRACTION_PROVIDERS: {
    anthropic: { displayName: 'Anthropic', models: [] },
  },
}));

import { GET, PATCH } from './route';
import { NextRequest } from 'next/server';

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3003/api/admin/config', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PATCH /api/admin/config — extractTimeoutSeconds (issue #86)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton', extractTimeoutSeconds: 90 });
  });

  it('writes a valid number within range', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 240 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(240);
  });

  it('clamps a value below the 30s floor to 30', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 5 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(30);
  });

  it('clamps a value above the 600s ceiling to 600', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 9999 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(600);
  });

  it('rejects NaN from a cleared number input without crashing Prisma', async () => {
    // The admin UI sends `Number('')` which is NaN. `typeof NaN === 'number'`
    // is true, so without a Number.isFinite guard the NaN would have been
    // routed to Prisma which would 500 on the Int column write.
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: NaN }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('extractTimeoutSeconds');
  });

  it('rejects Infinity without crashing Prisma', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: Infinity }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('extractTimeoutSeconds');
  });

  it('skips the field when it is a string', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: '120' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('extractTimeoutSeconds');
  });

  it('rounds a fractional value to the nearest integer', async () => {
    const res = await PATCH(patchRequest({ extractTimeoutSeconds: 47.6 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.extractTimeoutSeconds).toBe(48);
  });
});

describe('PATCH /api/admin/config — maxTrackedPerRoute (issue #89)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton', maxTrackedPerRoute: 10 });
  });

  it('writes a valid number within range', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 30 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(30);
  });

  it('clamps a value below the floor of 1 up to 1', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 0 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(1);
  });

  it('clamps a value above the ceiling of 50 down to 50', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 999 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(50);
  });

  it('rejects NaN from a cleared number input without crashing Prisma', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: NaN }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('maxTrackedPerRoute');
  });

  it('rounds a fractional value to the nearest integer', async () => {
    const res = await PATCH(patchRequest({ maxTrackedPerRoute: 12.4 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.maxTrackedPerRoute).toBe(12);
  });
});

describe('PATCH /api/admin/config — notification settings (issue #106)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('clamps notifyMinDropPct into the 0..1 range', async () => {
    const res = await PATCH(patchRequest({ notifyMinDropPct: 5 }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.notifyMinDropPct).toBe(1);
  });

  it('clamps a negative notifyMinDropAbs up to 0', async () => {
    await PATCH(patchRequest({ notifyMinDropAbs: -3 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.notifyMinDropAbs).toBe(0);
  });

  it('rejects an invalid publicBaseUrl', async () => {
    const res = await PATCH(patchRequest({ publicBaseUrl: 'not a url' }));
    expect(res.status).toBe(400);
  });

  it('accepts a valid publicBaseUrl', async () => {
    const res = await PATCH(patchRequest({ publicBaseUrl: 'https://flights.example.com' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.publicBaseUrl).toBe('https://flights.example.com');
  });

  it('stores null when publicBaseUrl is cleared', async () => {
    await PATCH(patchRequest({ publicBaseUrl: '' }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.publicBaseUrl).toBeNull();
  });

  it('accepts a valid family theme id as the instance default', async () => {
    const res = await PATCH(patchRequest({ theme: 'tron-light' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.theme).toBe('tron-light');
  });

  it('rejects a legacy flat theme id (must be family-mode now)', async () => {
    const res = await PATCH(patchRequest({ theme: 'basic-dark' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown theme id', async () => {
    const res = await PATCH(patchRequest({ theme: 'not-a-theme' }));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/admin/config — perf knobs (issue #106 gaps 2 & 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('clamps and rounds an out-of-range RPM override', async () => {
    await PATCH(patchRequest({ anthropicRpm: 99999.6 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.anthropicRpm).toBe(10000);
  });

  it('clears an RPM override when set to null', async () => {
    await PATCH(patchRequest({ googleRpm: null }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.googleRpm).toBeNull();
  });

  it('clamps previewConcurrency to the 10 ceiling (matching the env path)', async () => {
    await PATCH(patchRequest({ previewConcurrency: 999 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.previewConcurrency).toBe(10);
  });

  it('clamps previewAdmissionCap to the 50 ceiling', async () => {
    await PATCH(patchRequest({ previewAdmissionCap: 999 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.previewAdmissionCap).toBe(50);
  });

  it('ignores a non-numeric RPM value instead of writing NaN', async () => {
    await PATCH(patchRequest({ openaiRpm: 'fast' }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('openaiRpm');
  });
});

describe('PATCH /api/admin/config: admin password (AUTH-3, AUTH-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: 'singleton' });
  });

  it('rejects a password shorter than 8 characters with 400', async () => {
    const res = await PATCH(patchRequest({ adminPassword: 'short' }));
    expect(res.status).toBe(400);
    // Nothing must be written when the password is rejected.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('accepts an 8+ character password and revokes existing sessions', async () => {
    const before = Date.now();
    const res = await PATCH(patchRequest({ adminPassword: 'longenough123' }));
    expect(res.status).toBe(200);
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    // The password is stored hashed, never in plaintext.
    expect(data.update.adminPasswordHash).toEqual(expect.any(String));
    expect(data.update.adminPasswordHash).not.toBe('longenough123');
    // A revocation cutoff is stamped so older admin tokens are invalidated.
    const validFrom = data.update.adminSessionsValidFrom as Date;
    expect(validFrom).toBeInstanceOf(Date);
    expect(validFrom.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('does not stamp adminSessionsValidFrom when no password is set', async () => {
    await PATCH(patchRequest({ extractTimeoutSeconds: 120 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update).not.toHaveProperty('adminSessionsValidFrom');
  });
});

describe('GET /api/admin/config: secret redaction (CRYPTO-5/COMM-8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not return the community API key in plaintext', async () => {
    const realKey = 'comm_live_abcdefghijklmnopqrstuvwxyz1234';
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      communityApiKey: realKey,
      adminPasswordHash: 'hash',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { communityApiKey: string | null } };
    // The full secret must never cross the wire.
    expect(json.data.communityApiKey).not.toBe(realKey);
    expect(json.data.communityApiKey).not.toContain(realKey.slice(8, -4));
    // A masked fingerprint is still returned so the UI can render it.
    expect(json.data.communityApiKey).toContain('...');
  });

  it('does not leak the admin password hash', async () => {
    mockUpsert.mockResolvedValue({
      id: 'singleton',
      adminPasswordHash: 'super-secret-hash',
      communityApiKey: null,
    });

    const res = await GET();
    const json = (await res.json()) as {
      data: { adminPasswordHash?: string; hasAdminPassword: boolean; communityApiKey: string | null };
    };
    expect(json.data.adminPasswordHash).toBeUndefined();
    expect(json.data.hasAdminPassword).toBe(true);
    expect(json.data.communityApiKey).toBeNull();
  });
});
