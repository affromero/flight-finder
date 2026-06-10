import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockFindUnique = vi.fn();
const mockVerifyHashed = vi.fn();
const mockSetSessionCookie = vi.fn();
const mockCreateUserSessionToken = vi.fn();
const mockIsMultiUserEnabled = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
  },
}));

vi.mock('@/lib/password', () => ({
  verifyHashedPassword: (...args: unknown[]) => mockVerifyHashed(...args),
}));

vi.mock('@/lib/admin-auth', () => ({
  setSessionCookie: (...args: unknown[]) => mockSetSessionCookie(...args),
}));

vi.mock('@/lib/user-auth', () => ({
  createUserSessionToken: (...args: unknown[]) => mockCreateUserSessionToken(...args),
}));

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

const rateLimitState = { failures: 0, retryAfter: 0, keys: [] as string[] };
vi.mock('@/lib/rate-limit', () => ({
  incrementAuthFailure: vi.fn(async (key: string) => {
    rateLimitState.keys.push(key);
    rateLimitState.failures++;
    return rateLimitState.failures;
  }),
  getAuthFailureCount: vi.fn(async (key: string) => {
    rateLimitState.keys.push(key);
    return rateLimitState.failures;
  }),
  getRetryAfterSeconds: vi.fn(async () => rateLimitState.retryAfter),
  clearAuthFailures: vi.fn(async () => {
    rateLimitState.failures = 0;
  }),
}));

import { POST } from './route';

function makeRequest(body: unknown, forwardedFor = '10.0.0.1'): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': forwardedFor },
  });
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockVerifyHashed.mockReset();
    mockSetSessionCookie.mockReset();
    mockCreateUserSessionToken.mockReset();
    mockIsMultiUserEnabled.mockResolvedValue(true);
    rateLimitState.failures = 0;
    rateLimitState.retryAfter = 0;
    rateLimitState.keys = [];
    delete process.env.TRUSTED_FORWARDED_FOR;
  });

  afterEach(() => {
    delete process.env.TRUSTED_FORWARDED_FOR;
  });

  it('returns 404 when multi user mode is disabled', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await POST(makeRequest({ username: 'alice', password: 'p' }));
    expect(res.status).toBe(404);
  });

  it('rejects a missing username with 400 (password is optional)', async () => {
    const res = await POST(makeRequest({ password: 'x' }));
    expect(res.status).toBe(400);
  });

  it('signs in a passwordless member without checking a password', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u9', username: 'guest1', passwordHash: null, isAdmin: false, displayName: 'Guest 1' });
    mockCreateUserSessionToken.mockReturnValue('tok');
    const res = await POST(makeRequest({ username: 'guest1', password: '' }));
    expect(res.status).toBe(200);
    expect(mockVerifyHashed).not.toHaveBeenCalled();
    expect(mockSetSessionCookie).toHaveBeenCalledWith('tok');
  });

  it('rejects unknown user with 401 and bumps failure counter', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ username: 'ghost', password: 'x' }));
    expect(res.status).toBe(401);
    expect(rateLimitState.failures).toBe(1);
  });

  it('rejects wrong password with 401 and bumps failure counter', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1', username: 'alice', passwordHash: 'h', isAdmin: false, displayName: null });
    mockVerifyHashed.mockResolvedValue(false);
    const res = await POST(makeRequest({ username: 'alice', password: 'wrong' }));
    expect(res.status).toBe(401);
    expect(rateLimitState.failures).toBe(1);
  });

  it('returns user payload and sets cookie on success', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1', username: 'alice', passwordHash: 'h', isAdmin: true, displayName: 'Alice' });
    mockVerifyHashed.mockResolvedValue(true);
    mockCreateUserSessionToken.mockReturnValue('user-token-abc');
    rateLimitState.failures = 3;

    const res = await POST(makeRequest({ username: 'alice', password: 'correct' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user).toEqual({
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      isAdmin: true,
    });
    expect(mockSetSessionCookie).toHaveBeenCalledWith('user-token-abc');
    expect(rateLimitState.failures).toBe(0);
  });

  it('returns 429 with Retry-After header when over limit', async () => {
    rateLimitState.failures = 5;
    rateLimitState.retryAfter = 300;
    const res = await POST(makeRequest({ username: 'alice', password: 'wrong' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  it('derives distinct rate-limit buckets per forwarded IP when a proxy is trusted', async () => {
    mockFindUnique.mockResolvedValue(null);
    await POST(makeRequest({ username: 'alice', password: 'x' }, '1.1.1.1'));
    await POST(makeRequest({ username: 'alice', password: 'x' }, '2.2.2.2'));
    const distinct = new Set(rateLimitState.keys);
    expect(distinct.has('1.1.1.1:alice')).toBe(true);
    expect(distinct.has('2.2.2.2:alice')).toBe(true);
  });

  it('collapses spoofed x-forwarded-for into one bucket when no proxy is trusted', async () => {
    process.env.TRUSTED_FORWARDED_FOR = 'false';
    mockFindUnique.mockResolvedValue(null);
    await POST(makeRequest({ username: 'alice', password: 'x' }, '1.1.1.1'));
    await POST(makeRequest({ username: 'alice', password: 'x' }, '2.2.2.2'));
    const distinct = new Set(rateLimitState.keys);
    expect(distinct.size).toBe(1);
    expect(distinct.has('1.1.1.1:alice')).toBe(false);
    expect(distinct.has('2.2.2.2:alice')).toBe(false);
  });
});
