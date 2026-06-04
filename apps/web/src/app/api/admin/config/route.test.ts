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

import { PATCH } from './route';
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

  it('clamps previewConcurrency to the 16 ceiling', async () => {
    await PATCH(patchRequest({ previewConcurrency: 999 }));
    const data = mockUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(data.update.previewConcurrency).toBe(16);
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
