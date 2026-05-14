import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockHashPassword = vi.fn();
const mockIsMultiUserEnabled = vi.fn();
const mockGetCurrentUser = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
}));

vi.mock('@/lib/password', () => ({
  hashPassword: (pw: string) => mockHashPassword(pw),
}));

vi.mock('@/lib/multi-user', () => ({
  isMultiUserEnabled: () => mockIsMultiUserEnabled(),
}));

vi.mock('@/lib/user-auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { PATCH, DELETE } from './route';

function makePatch(id: string, body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  ];
}

function makeDelete(id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/admin/users/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  ];
}

describe('PATCH /api/admin/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'admin_1', isAdmin: true });
    mockHashPassword.mockResolvedValue('hash');
    mockUpdate.mockResolvedValue({ id: 'u1', username: 'bob' });
  });

  it('updates displayName', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1', isAdmin: false });
    const res = await PATCH(...makePatch('u1', { displayName: 'Bobby' }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { displayName: 'Bobby' },
      select: expect.any(Object),
    });
  });

  it('blocks admin from removing their own admin flag', async () => {
    mockFindUnique.mockResolvedValue({ id: 'admin_1', isAdmin: true });
    const res = await PATCH(...makePatch('admin_1', { isAdmin: false }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('hashes new password on reset', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1', isAdmin: false });
    const res = await PATCH(...makePatch('u1', { password: 'longenough' }));
    expect(res.status).toBe(200);
    expect(mockHashPassword).toHaveBeenCalledWith('longenough');
  });

  it('rejects short password', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1', isAdmin: false });
    const res = await PATCH(...makePatch('u1', { password: 'short' }));
    expect(res.status).toBe(400);
  });

  it('rejects request with no supported fields', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1', isAdmin: false });
    const res = await PATCH(...makePatch('u1', { unknownField: 'x' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'admin_1', isAdmin: true });
  });

  it('blocks admin from deleting themselves', async () => {
    const res = await DELETE(...makeDelete('admin_1'));
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 404 if user not found', async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await DELETE(...makeDelete('ghost'));
    expect(res.status).toBe(404);
  });

  it('deletes the target user', async () => {
    mockFindUnique.mockResolvedValue({ id: 'u1' });
    mockDelete.mockResolvedValue({});
    const res = await DELETE(...makeDelete('u1'));
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});
