import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockHashPassword = vi.fn();
const mockIsMultiUserEnabled = vi.fn();
const mockGetCurrentUser = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      create: (...args: unknown[]) => mockCreate(...args),
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

import { GET, POST } from './route';

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET /api/admin/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'admin_1', isAdmin: true });
    mockFindMany.mockResolvedValue([]);
  });

  it('returns 404 when multi user mode is off', async () => {
    mockIsMultiUserEnabled.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('returns 401 when no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user_1', isAdmin: false });
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('returns the user list for admin', async () => {
    mockFindMany.mockResolvedValue([{ id: 'u1', username: 'admin', isAdmin: true }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.users).toHaveLength(1);
  });
});

describe('POST /api/admin/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMultiUserEnabled.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'admin_1', isAdmin: true });
    mockHashPassword.mockResolvedValue('hash');
    mockFindUnique.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: 'u2',
      username: 'bob',
      displayName: null,
      isAdmin: false,
      createdAt: new Date(),
    });
  });

  it('rejects bad username', async () => {
    const res = await POST(makePost({ username: 'a', password: 'longenough' }));
    expect(res.status).toBe(400);
  });

  it('rejects short password', async () => {
    const res = await POST(makePost({ username: 'bob', password: 'short' }));
    expect(res.status).toBe(400);
  });

  it('rejects duplicate username with 409', async () => {
    mockFindUnique.mockResolvedValue({ id: 'existing' });
    const res = await POST(makePost({ username: 'bob', password: 'longenough' }));
    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates the user and returns 201', async () => {
    const res = await POST(makePost({ username: 'bob', password: 'longenough', displayName: 'Bob' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.user.username).toBe('bob');
    expect(mockCreate).toHaveBeenCalled();
  });

  it('passes a valid preset avatar slug to create', async () => {
    const res = await POST(makePost({ username: 'bob', password: 'longenough', avatar: 'globe' }));
    expect(res.status).toBe(201);
    const args = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.avatar).toBe('globe');
  });

  it('drops an unknown avatar slug to null', async () => {
    const res = await POST(makePost({ username: 'bob', password: 'longenough', avatar: 'bogus' }));
    expect(res.status).toBe(201);
    const args = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.avatar).toBeNull();
  });

  it('creates a passwordless member when no password is given', async () => {
    const res = await POST(makePost({ username: 'guest1' }));
    expect(res.status).toBe(201);
    const args = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.passwordHash).toBeNull();
  });

  it('allows a passwordless admin (self-hosted is already open)', async () => {
    const res = await POST(makePost({ username: 'boss', isAdmin: true }));
    expect(res.status).toBe(201);
    const args = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(args.data.passwordHash).toBeNull();
    expect(args.data.isAdmin).toBe(true);
  });
});
