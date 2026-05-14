import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findUnique: (...args: unknown[]) => mockConfigFindUnique(...args),
      upsert: (...args: unknown[]) => mockConfigUpsert(...args),
      updateMany: (...args: unknown[]) => mockConfigUpdateMany(...args),
    },
    user: {
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
}));

vi.mock('@/lib/admin-auth', () => ({
  getSessionToken: () => mockGetSessionToken(),
  verifySessionToken: (...args: unknown[]) => mockVerifySessionToken(...args),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { POST } from './route';

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
});
