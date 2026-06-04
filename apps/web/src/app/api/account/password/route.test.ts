import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { hashPassword } from '@/lib/password';

const mockIsMultiUserEnabled = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockUserUpdate = vi.fn();
const mockGetFailureCount = vi.fn();
const mockIncrementFailure = vi.fn();
const mockClearFailures = vi.fn();
const mockRetryAfter = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { update: (...a: unknown[]) => mockUserUpdate(...a) } },
}));
vi.mock('@/lib/multi-user', () => ({ isMultiUserEnabled: () => mockIsMultiUserEnabled() }));
vi.mock('@/lib/user-auth', () => ({ getCurrentUser: () => mockGetCurrentUser() }));
vi.mock('@/lib/rate-limit', () => ({
  getAuthFailureCount: () => mockGetFailureCount(),
  incrementAuthFailure: () => mockIncrementFailure(),
  clearAuthFailures: () => mockClearFailures(),
  getRetryAfterSeconds: () => mockRetryAfter(),
}));

import { POST } from './route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/account/password', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

let currentHash: string;

beforeEach(async () => {
  vi.clearAllMocks();
  currentHash = await hashPassword('oldpassword');
  mockIsMultiUserEnabled.mockResolvedValue(true);
  mockGetCurrentUser.mockResolvedValue({ id: 'u1', passwordHash: currentHash });
  mockGetFailureCount.mockResolvedValue(0);
  mockRetryAfter.mockResolvedValue(900);
  mockUserUpdate.mockResolvedValue({});
});

describe('POST /api/account/password', () => {
  it('changes the password when the current one is correct', async () => {
    const res = await POST(req({ currentPassword: 'oldpassword', newPassword: 'newpassword1' }));
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' } }),
    );
    // The stored hash is freshly derived, never the plaintext, and the change
    // revokes existing sessions.
    const data = (mockUserUpdate.mock.calls[0]![0] as { data: { passwordHash: string; sessionsValidFrom: unknown } }).data;
    expect(data.passwordHash).not.toBe('newpassword1');
    expect(data.passwordHash).toContain(':');
    expect(data.sessionsValidFrom).toBeInstanceOf(Date);
    expect(mockClearFailures).toHaveBeenCalled();
  });

  it('rejects a wrong current password and records a failed attempt', async () => {
    const res = await POST(req({ currentPassword: 'wrongpassword', newPassword: 'newpassword1' }));
    expect(res.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockIncrementFailure).toHaveBeenCalled();
  });

  it('rejects a too-short new password before checking the current one', async () => {
    const res = await POST(req({ currentPassword: 'oldpassword', newPassword: 'short' }));
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('throttles after too many failed attempts', async () => {
    mockGetFailureCount.mockResolvedValue(5);
    const res = await POST(req({ currentPassword: 'whatever', newPassword: 'newpassword1' }));
    expect(res.status).toBe(429);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 outside multi user mode', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await POST(req({ currentPassword: 'oldpassword', newPassword: 'newpassword1' }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not signed in', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(req({ currentPassword: 'oldpassword', newPassword: 'newpassword1' }));
    expect(res.status).toBe(401);
  });
});
