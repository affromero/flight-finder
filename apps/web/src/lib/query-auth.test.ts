import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsMultiUserEnabled = vi.fn().mockResolvedValue(false);
const mockGetCurrentUser = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

// canManageQueryWithoutToken never touches admin-auth, but the module imports
// it for authorizeMutation, so stub it to keep the import graph headless-safe.
vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: vi.fn().mockResolvedValue(undefined),
  verifySessionToken: vi.fn().mockReturnValue(false),
}));

import { canManageQueryWithoutToken } from './query-auth';

const ORIGINAL_SELF_HOSTED = process.env.SELF_HOSTED;

describe('canManageQueryWithoutToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
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
