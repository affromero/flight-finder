import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsMultiUserEnabled = vi.fn();
const mockGetCurrentUser = vi.fn();

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { requireAdminApi } from './admin-guard';

describe('requireAdminApi', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
