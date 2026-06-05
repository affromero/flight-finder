import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsMultiUserEnabled = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockGetSessionToken = vi.fn();
const mockVerifySessionToken = vi.fn();
const mockParseAdminTokenTimestamp = vi.fn();
const mockConfigFindUnique = vi.fn();

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: () => mockGetSessionToken(),
  verifySessionToken: (t: string) => mockVerifySessionToken(t),
  parseAdminTokenTimestamp: (t: string) => mockParseAdminTokenTimestamp(t),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findUnique: (...args: unknown[]) => mockConfigFindUnique(...args),
    },
  },
}));

import { requireAdminApi, verifyAdminSessionRevocable } from './admin-guard';

describe('requireAdminApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no admin session cookie present, so the revocation check is a
    // no-op and flow falls through to the multi-user checks.
    mockGetSessionToken.mockResolvedValue(undefined);
    mockVerifySessionToken.mockReturnValue(false);
    mockParseAdminTokenTimestamp.mockReturnValue(null);
    mockConfigFindUnique.mockResolvedValue(null);
  });

  it('returns null in solo / hosted mode (multi-user off)', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    expect(await requireAdminApi()).toBeNull();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('returns 401 in multi-user mode when no session', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await requireAdminApi();
    expect(res?.status).toBe(401);
  });

  it('returns 403 in multi-user mode when user is not admin', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', isAdmin: false });
    const res = await requireAdminApi();
    expect(res?.status).toBe(403);
  });

  it('returns null in multi-user mode when caller is admin', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'a1', isAdmin: true });
    expect(await requireAdminApi()).toBeNull();
  });

  it('rejects an admin token issued before adminSessionsValidFrom', async () => {
    // Valid HMAC, but the token predates the last admin password change.
    const issuedAt = 1_000;
    mockGetSessionToken.mockResolvedValue('admin:1000.sig');
    mockVerifySessionToken.mockReturnValue(true);
    mockParseAdminTokenTimestamp.mockReturnValue(issuedAt);
    mockConfigFindUnique.mockResolvedValue({
      adminSessionsValidFrom: new Date(issuedAt + 5_000),
    });

    const res = await requireAdminApi();
    expect(res?.status).toBe(401);
    // The revocation check short-circuits before the multi-user branch.
    expect(mockIsMultiUserEnabled).not.toHaveBeenCalled();
  });

  it('allows an admin token issued after adminSessionsValidFrom', async () => {
    const issuedAt = 10_000;
    mockGetSessionToken.mockResolvedValue('admin:10000.sig');
    mockVerifySessionToken.mockReturnValue(true);
    mockParseAdminTokenTimestamp.mockReturnValue(issuedAt);
    mockConfigFindUnique.mockResolvedValue({
      adminSessionsValidFrom: new Date(issuedAt - 5_000),
    });
    mockIsMultiUserEnabled.mockResolvedValue(false);

    expect(await requireAdminApi()).toBeNull();
  });

  it('allows an admin token when adminSessionsValidFrom is unset', async () => {
    mockGetSessionToken.mockResolvedValue('admin:10000.sig');
    mockVerifySessionToken.mockReturnValue(true);
    mockParseAdminTokenTimestamp.mockReturnValue(10_000);
    mockConfigFindUnique.mockResolvedValue({ adminSessionsValidFrom: null });
    mockIsMultiUserEnabled.mockResolvedValue(false);

    expect(await requireAdminApi()).toBeNull();
  });

  it('ignores a forged admin cookie that fails HMAC verification', async () => {
    // verifySessionToken returns false, so the revocation branch never queries
    // the DB and flow continues to the normal checks.
    mockGetSessionToken.mockResolvedValue('admin:1.forged');
    mockVerifySessionToken.mockReturnValue(false);
    mockIsMultiUserEnabled.mockResolvedValue(false);

    expect(await requireAdminApi()).toBeNull();
    expect(mockConfigFindUnique).not.toHaveBeenCalled();
  });
});

describe('verifyAdminSessionRevocable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionToken.mockResolvedValue(undefined);
    mockVerifySessionToken.mockReturnValue(false);
    mockParseAdminTokenTimestamp.mockReturnValue(null);
    mockConfigFindUnique.mockResolvedValue(null);
  });

  it('returns false when no admin cookie is present', async () => {
    mockGetSessionToken.mockResolvedValue(undefined);
    expect(await verifyAdminSessionRevocable()).toBe(false);
    expect(mockConfigFindUnique).not.toHaveBeenCalled();
  });

  it('returns false for a forged cookie that fails HMAC verification', async () => {
    mockGetSessionToken.mockResolvedValue('admin:1.forged');
    mockVerifySessionToken.mockReturnValue(false);
    expect(await verifyAdminSessionRevocable()).toBe(false);
    expect(mockConfigFindUnique).not.toHaveBeenCalled();
  });

  it('returns false for a token issued before adminSessionsValidFrom', async () => {
    const issuedAt = 1_000;
    mockGetSessionToken.mockResolvedValue('admin:1000.sig');
    mockVerifySessionToken.mockReturnValue(true);
    mockParseAdminTokenTimestamp.mockReturnValue(issuedAt);
    mockConfigFindUnique.mockResolvedValue({
      adminSessionsValidFrom: new Date(issuedAt + 5_000),
    });
    expect(await verifyAdminSessionRevocable()).toBe(false);
  });

  it('returns true for a token issued after adminSessionsValidFrom', async () => {
    const issuedAt = 10_000;
    mockGetSessionToken.mockResolvedValue('admin:10000.sig');
    mockVerifySessionToken.mockReturnValue(true);
    mockParseAdminTokenTimestamp.mockReturnValue(issuedAt);
    mockConfigFindUnique.mockResolvedValue({
      adminSessionsValidFrom: new Date(issuedAt - 5_000),
    });
    expect(await verifyAdminSessionRevocable()).toBe(true);
  });

  it('returns true when adminSessionsValidFrom is unset', async () => {
    mockGetSessionToken.mockResolvedValue('admin:10000.sig');
    mockVerifySessionToken.mockReturnValue(true);
    mockParseAdminTokenTimestamp.mockReturnValue(10_000);
    mockConfigFindUnique.mockResolvedValue({ adminSessionsValidFrom: null });
    expect(await verifyAdminSessionRevocable()).toBe(true);
  });
});
