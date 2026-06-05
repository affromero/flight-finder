import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);
const mockVerifyAdminSessionRevocable = vi.fn().mockResolvedValue(false);

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

// authorizeMutation's hosted admin branch goes through the revocation-aware
// admin check (HMAC + expiry + adminSessionsValidFrom). Mock it at the
// admin-guard boundary so we can assert how a revoked vs valid admin cookie is
// treated. canManageQueryWithoutToken never touches it.
vi.mock('@/lib/admin-guard', () => ({
  verifyAdminSessionRevocable: () => mockVerifyAdminSessionRevocable(),
}));

import { authorizeMutation, canManageQueryWithoutToken } from './query-auth';

const ORIGINAL_SELF_HOSTED = process.env.SELF_HOSTED;

describe('authorizeMutation hosted admin branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyAdminSessionRevocable.mockResolvedValue(false);
    // Pure hosted mode: SELF_HOSTED unset.
    delete process.env.SELF_HOSTED;
  });

  afterEach(() => {
    if (ORIGINAL_SELF_HOSTED === undefined) delete process.env.SELF_HOSTED;
    else process.env.SELF_HOSTED = ORIGINAL_SELF_HOSTED;
  });

  it('authorizes a valid (non-revoked) admin session', async () => {
    mockVerifyAdminSessionRevocable.mockResolvedValue(true);
    const res = await authorizeMutation({ deleteToken: null, userId: null }, undefined);
    expect(res.ok).toBe(true);
  });

  it('rejects an admin cookie revoked by a password change (no delete token)', async () => {
    // The admin token predates adminSessionsValidFrom, so the revocation-aware
    // check returns false. With no delete token supplied, the request is denied
    // instead of being silently authorized on a stale admin cookie.
    mockVerifyAdminSessionRevocable.mockResolvedValue(false);
    const res = await authorizeMutation({ deleteToken: 'real-token', userId: null }, undefined);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('falls back to the delete token when the admin cookie is revoked', async () => {
    // A revoked admin cookie must not grant access on its own, but a caller
    // presenting the correct delete token is still authorized.
    mockVerifyAdminSessionRevocable.mockResolvedValue(false);
    const res = await authorizeMutation({ deleteToken: 'real-token', userId: null }, 'real-token');
    expect(res.ok).toBe(true);
  });

  it('rejects a revoked admin cookie paired with a wrong delete token', async () => {
    mockVerifyAdminSessionRevocable.mockResolvedValue(false);
    const res = await authorizeMutation({ deleteToken: 'real-token', userId: null }, 'wrong-token');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});

describe('canManageQueryWithoutToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyAdminSessionRevocable.mockResolvedValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_SELF_HOSTED === undefined) delete process.env.SELF_HOSTED;
    else process.env.SELF_HOSTED = ORIGINAL_SELF_HOSTED;
  });

  it('allows anyone in self-hosted solo mode (no token needed)', async () => {
    process.env.SELF_HOSTED = 'true';
    mockIsMultiUserEnabled.mockResolvedValue(false);
    expect(await canManageQueryWithoutToken({ userId: null })).toBe(true);
  });

  it('allows an admin in multi-user mode', async () => {
    process.env.SELF_HOSTED = 'true';
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'u-admin', isAdmin: true });
    expect(await canManageQueryWithoutToken({ userId: 'someone-else' })).toBe(true);
  });

  it('allows the owning user in multi-user mode', async () => {
    process.env.SELF_HOSTED = 'true';
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'u-owner', isAdmin: false });
    expect(await canManageQueryWithoutToken({ userId: 'u-owner' })).toBe(true);
  });

  it('denies a non-owning user in multi-user mode', async () => {
    process.env.SELF_HOSTED = 'true';
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'u-other', isAdmin: false });
    expect(await canManageQueryWithoutToken({ userId: 'u-owner' })).toBe(false);
  });

  it('denies a logged-in non-admin for an ownerless/seed query in multi-user mode', async () => {
    process.env.SELF_HOSTED = 'true';
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'u-other', isAdmin: false });
    expect(await canManageQueryWithoutToken({ userId: null })).toBe(false);
  });

  it('denies anonymous visitors in pure hosted mode (token is the only key)', async () => {
    delete process.env.SELF_HOSTED;
    expect(await canManageQueryWithoutToken({ userId: 'u-owner' })).toBe(false);
    expect(mockIsMultiUserEnabled).not.toHaveBeenCalled();
  });
});
