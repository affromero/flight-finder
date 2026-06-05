import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockConfigFindUnique = vi.fn();
const mockConfigUpsert = vi.fn();
const mockConfigUpdateMany = vi.fn();
const mockUserCreate = vi.fn();
const mockQueryUpdateMany = vi.fn();

const mockHashPassword = vi.fn();
const mockInvalidateCache = vi.fn();
const mockGetSessionToken = vi.fn();
const mockVerifySessionToken = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockIsMultiUserEnabled = vi.fn();
const mockRequireAdmin = vi.fn();
const mockDisable = vi.fn();
const mockUserCount = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findUnique: (...args: unknown[]) => mockConfigFindUnique(...args),
      upsert: (...args: unknown[]) => mockConfigUpsert(...args),
      updateMany: (...args: unknown[]) => mockConfigUpdateMany(...args),
    },
    user: {
      count: () => mockUserCount(),
      create: (...args: unknown[]) => mockUserCreate(...args),
    },
    query: {
      updateMany: (...args: unknown[]) => mockQueryUpdateMany(...args),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { create: (...args: unknown[]) => mockUserCreate(...args) },
        extractionConfig: {
          upsert: (...args: unknown[]) => mockConfigUpsert(...args),
          updateMany: (...args: unknown[]) => mockConfigUpdateMany(...args),
        },
        query: { updateMany: (...args: unknown[]) => mockQueryUpdateMany(...args) },
      }),
  },
}));

vi.mock('@/lib/password', () => ({
  hashPassword: (pw: string) => mockHashPassword(pw),
}));

vi.mock('@/lib/multi-user', () => ({
  invalidateMultiUserCache: () => mockInvalidateCache(),
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: () => mockGetSessionToken(),
  verifySessionToken: (...args: unknown[]) => mockVerifySessionToken(...args),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

vi.mock('@/lib/admin-guard', () => ({
  requireAdminApi: () => mockRequireAdmin(),
}));

vi.mock('@/lib/admin-recovery', () => ({
  disableMultiUserMode: () => mockDisable(),
}));

import { POST, DELETE } from './route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/multi-user', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/admin/multi-user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SELF_HOSTED = 'true';
    mockConfigFindUnique.mockResolvedValue({ multiUserMode: false });
    // Default: no users exist yet (first-boot window allows unauthenticated access).
    mockUserCount.mockResolvedValue(0);
    mockGetSessionToken.mockResolvedValue(undefined);
    mockVerifySessionToken.mockReturnValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    mockHashPassword.mockResolvedValue('hashed:secret');
    mockUserCreate.mockResolvedValue({
      id: 'user_1',
      username: 'admin',
      displayName: null,
      isAdmin: true,
    });
    mockConfigUpsert.mockResolvedValue({});
    mockConfigUpdateMany.mockResolvedValue({ count: 1 });
    mockQueryUpdateMany.mockResolvedValue({ count: 0 });
  });

  it('rejects when SELF_HOSTED is not true', async () => {
    delete process.env.SELF_HOSTED;
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'pw12345678' }));
    expect(res.status).toBe(400);
  });

  it('rejects when multi user mode is already enabled', async () => {
    mockConfigFindUnique.mockResolvedValue({ multiUserMode: true });
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'pw12345678' }));
    expect(res.status).toBe(409);
  });

  it('rejects bad username with 400', async () => {
    const res = await POST(makeRequest({ adminUsername: 'a', adminPassword: 'pw12345678' }));
    expect(res.status).toBe(400);
  });

  it('rejects short password with 400', async () => {
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'short' }));
    expect(res.status).toBe(400);
  });

  it('creates user, flips flag, backfills, and invalidates cache', async () => {
    mockQueryUpdateMany.mockResolvedValue({ count: 7 });
    const res = await POST(
      makeRequest({ adminUsername: 'admin', adminPassword: 'longenough', displayName: 'Admin' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.user.username).toBe('admin');
    expect(body.data.backfillCount).toBe(7);

    expect(mockUserCreate).toHaveBeenCalledWith({
      data: {
        username: 'admin',
        displayName: 'Admin',
        passwordHash: 'hashed:secret',
        isAdmin: true,
      },
    });
    expect(mockConfigUpsert).toHaveBeenCalled();
    expect(mockQueryUpdateMany).toHaveBeenCalledWith({
      where: { userId: null, isSeed: false },
      data: { userId: 'user_1' },
    });
    expect(mockInvalidateCache).toHaveBeenCalled();
  });

  it('accepts a legacy admin session as authorization', async () => {
    process.env.SELF_HOSTED = 'true';
    mockGetSessionToken.mockResolvedValue('admin:123.sig');
    mockVerifySessionToken.mockReturnValue(true);
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'longenough' }));
    expect(res.status).toBe(201);
  });

  it('returns 409 when the guarded updateMany returns count=0 (concurrent enable race)', async () => {
    // Fast-path findUnique sees multiUserMode=false, but by the time the
    // transaction runs another caller has already flipped the flag, so the
    // guarded updateMany matches zero rows.
    mockConfigUpdateMany.mockResolvedValue({ count: 0 });
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'longenough' }));
    expect(res.status).toBe(409);
    expect(mockUserCreate).not.toHaveBeenCalled();
    expect(mockQueryUpdateMany).not.toHaveBeenCalled();
    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });

  it('allows unauthenticated bootstrap when the User table is empty (first-boot)', async () => {
    // No session provided, no users in DB: first-boot window must be open.
    mockUserCount.mockResolvedValue(0);
    mockGetSessionToken.mockResolvedValue(undefined);
    mockVerifySessionToken.mockReturnValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'longenough' }));
    expect(res.status).toBe(201);
  });

  it('rejects unauthenticated call with 401 once a User row already exists', async () => {
    // A user exists: first-boot window is closed, auth is now required.
    mockUserCount.mockResolvedValue(1);
    mockGetSessionToken.mockResolvedValue(undefined);
    mockVerifySessionToken.mockReturnValue(false);
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeRequest({ adminUsername: 'admin', adminPassword: 'longenough' }));
    expect(res.status).toBe(401);
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  it('allows an authenticated admin to re-enable after user rows exist', async () => {
    // User rows exist but the caller is an authenticated admin.
    mockUserCount.mockResolvedValue(1);
    mockGetSessionToken.mockResolvedValue('admin:123.sig');
    mockVerifySessionToken.mockReturnValue(true);
    const res = await POST(makeRequest({ adminUsername: 'admin2', adminPassword: 'longenough' }));
    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/admin/multi-user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SELF_HOSTED = 'true';
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockRequireAdmin.mockResolvedValue(null);
    mockDisable.mockResolvedValue(undefined);
  });

  it('disables multi user mode for an authenticated admin', async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(mockDisable).toHaveBeenCalled();
  });

  it('rejects when SELF_HOSTED is not true', async () => {
    delete process.env.SELF_HOSTED;
    const res = await DELETE();
    expect(res.status).toBe(400);
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it('returns 404 when multi user mode is not enabled', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await DELETE();
    expect(res.status).toBe(404);
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller and does not disable', async () => {
    mockRequireAdmin.mockResolvedValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(mockDisable).not.toHaveBeenCalled();
  });
});
