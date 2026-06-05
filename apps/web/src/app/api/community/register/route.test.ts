import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreate, mockIncr, mockExpire, mockGetClientIp, mockFindUnique } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({ id: 'key_1' }),
  mockIncr: vi.fn(),
  mockExpire: vi.fn().mockResolvedValue(1),
  mockGetClientIp: vi.fn().mockReturnValue('203.0.113.5'),
  mockFindUnique: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    communityApiKey: { create: mockCreate },
    extractionConfig: { findUnique: mockFindUnique },
  },
}));

vi.mock('@/lib/redis', () => ({
  redis: { incr: mockIncr, expire: mockExpire },
}));

vi.mock('@/lib/trusted-ip', () => ({
  getClientIp: (req: Request) => mockGetClientIp(req),
}));

import { POST } from './route';

function makeRequest(): Request {
  return new Request('http://localhost/api/community/register', { method: 'POST' });
}

describe('POST /api/community/register', () => {
  const originalFlag = process.env.COMMUNITY_REGISTRATION_OPEN;

  beforeEach(() => {
    mockCreate.mockClear();
    mockIncr.mockReset();
    mockExpire.mockClear();
    mockGetClientIp.mockReturnValue('203.0.113.5');
    // Per-IP and global counters both report well under their caps by default.
    mockIncr.mockResolvedValue(1);
    // The admin toggle (DB flag) is off by default; the env override opens it.
    mockFindUnique.mockResolvedValue(null);
    process.env.COMMUNITY_REGISTRATION_OPEN = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.COMMUNITY_REGISTRATION_OPEN;
    } else {
      process.env.COMMUNITY_REGISTRATION_OPEN = originalFlag;
    }
  });

  it('is disabled by default: returns 403 and mints no key when the flag is unset', async () => {
    delete process.env.COMMUNITY_REGISTRATION_OPEN;
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 403 when the flag is set to anything other than "true"', async () => {
    process.env.COMMUNITY_REGISTRATION_OPEN = 'yes';
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('mints a key when registration is open and under both caps', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.apiKey).toMatch(/^ft_[0-9a-f]{64}$/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('mints a key when the admin toggle is on, even with the env override unset', async () => {
    delete process.env.COMMUNITY_REGISTRATION_OPEN;
    mockFindUnique.mockResolvedValue({ communityRegistrationOpen: true });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('derives the client IP from the trusted-ip helper, not the raw header', async () => {
    await POST(makeRequest());
    expect(mockGetClientIp).toHaveBeenCalled();
    // Per-IP counter key is namespaced by the helper-derived IP.
    expect(mockIncr).toHaveBeenCalledWith('community:register:203.0.113.5');
  });

  it('enforces the per-IP cap: 6th registration in the window is rejected with 429', async () => {
    mockIncr.mockResolvedValueOnce(6); // per-IP counter over RATE_LIMIT_MAX
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('enforces the global daily cap regardless of per-IP spoofing', async () => {
    // Per-IP passes (1), but the global counter is over its cap.
    mockIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(201);
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(mockCreate).not.toHaveBeenCalled();
    // The second incr is the global counter.
    expect(mockIncr).toHaveBeenCalledWith('community:register:global');
  });

  it('fails closed with 503 when the limiter cannot be consulted (Redis error)', async () => {
    mockIncr.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
