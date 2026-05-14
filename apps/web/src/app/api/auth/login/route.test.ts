import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const rateLimitState = { failures: 0, retryAfter: 0 };
vi.mock('@/lib/rate-limit', () => ({
  incrementAuthFailure: vi.fn(async () => {
    rateLimitState.failures++;
    return rateLimitState.failures;
  }),
  getAuthFailureCount: vi.fn(async () => rateLimitState.failures),
  getRetryAfterSeconds: vi.fn(async () => rateLimitState.retryAfter),
  clearAuthFailures: vi.fn(async () => {
    rateLimitState.failures = 0;
  }),
}));

import { POST } from './route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
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
  });

  it('returns 404 when multi user mode is disabled', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await POST(makeRequest({ username: 'alice', password: 'p' }));
    expect(res.status).toBe(404);
  });

  it('rejects missing fields with 400', async () => {
    const res = await POST(makeRequest({ username: 'alice' }));
    expect(res.status).toBe(400);
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
});
