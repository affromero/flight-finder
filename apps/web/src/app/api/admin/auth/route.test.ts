import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockVerifyPassword = vi.fn();
const mockCreateSessionToken = vi.fn();
const mockSetSessionCookie = vi.fn();
const mockIsMultiUserEnabled = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
  createSessionToken: () => mockCreateSessionToken(),
  setSessionCookie: (...args: unknown[]) => mockSetSessionCookie(...args),
}));

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

const rateLimitState = {
  failures: 0,
  retryAfter: 0,
};

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
  return new NextRequest('http://localhost/api/admin/auth', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/admin/auth', () => {
  beforeEach(() => {
    mockVerifyPassword.mockReset();
    mockCreateSessionToken.mockReset();
    mockSetSessionCookie.mockReset();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    rateLimitState.failures = 0;
    rateLimitState.retryAfter = 0;
  });

  it('rejects missing password with 400', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing password');
  });

  it('rejects invalid password with 401', async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const res = await POST(makeRequest({ password: 'wrong' }));
    expect(res.status).toBe(401);
  });

  it('returns success and sets cookie on valid password', async () => {
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSessionToken.mockReturnValue('session-token-123');
    mockSetSessionCookie.mockResolvedValue(undefined);

    const res = await POST(makeRequest({ password: 'correct' }));
    expect(res.status).toBe(200);
    expect(mockSetSessionCookie).toHaveBeenCalledWith('session-token-123');
  });

  it('returns 410 Gone when multi user mode is enabled', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    const res = await POST(makeRequest({ password: 'anything' }));
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain('/api/auth/login');
  });

  it('returns 429 after 5 failed attempts', async () => {
    mockVerifyPassword.mockResolvedValue(false);
    rateLimitState.failures = 5;
    rateLimitState.retryAfter = 60;
    const res = await POST(makeRequest({ password: 'wrong' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('clears rate limit counter on success', async () => {
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSessionToken.mockReturnValue('tok');
    rateLimitState.failures = 2;
    await POST(makeRequest({ password: 'correct' }));
    expect(rateLimitState.failures).toBe(0);
  });
});
