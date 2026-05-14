import { describe, it, expect, vi, beforeEach } from 'vitest';

const cookieStore = {
  get: vi.fn(),
};

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue(cookieStore),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

describe('parseSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses a freshly created admin token', async () => {
    const { createSessionToken } = await import('./admin-auth');
    const { parseSession } = await import('./user-auth');
    const token = createSessionToken();
    const parsed = parseSession(token);
    expect(parsed?.kind).toBe('admin');
  });

  it('parses a freshly created user token', async () => {
    const { createUserSessionToken, parseSession } = await import('./user-auth');
    const token = createUserSessionToken('user_abc123');
    const parsed = parseSession(token);
    expect(parsed).toEqual({
      kind: 'user',
      userId: 'user_abc123',
      ts: expect.any(Number),
    });
  });

  it('returns null for tokens without a dot', async () => {
    const { parseSession } = await import('./user-auth');
    expect(parseSession('garbage')).toBeNull();
  });

  it('returns null for tampered signature', async () => {
    const { createUserSessionToken, parseSession } = await import('./user-auth');
    const token = createUserSessionToken('u1');
    const flipped = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    expect(parseSession(flipped)).toBeNull();
  });

  it('returns null for unknown payload prefix', async () => {
    const { signPayload } = await import('./admin-auth');
    const { parseSession } = await import('./user-auth');
    const payload = `bogus:1234`;
    const token = `${payload}.${signPayload(payload)}`;
    expect(parseSession(token)).toBeNull();
  });

  it('returns null for user token with empty userId', async () => {
    const { signPayload } = await import('./admin-auth');
    const { parseSession } = await import('./user-auth');
    const payload = `user::123`;
    const token = `${payload}.${signPayload(payload)}`;
    expect(parseSession(token)).toBeNull();
  });
});

describe('verifyUserSession', () => {
  it('returns userId for valid user token', async () => {
    const { createUserSessionToken, verifyUserSession } = await import('./user-auth');
    const token = createUserSessionToken('uid_42');
    expect(verifyUserSession(token)).toEqual({ userId: 'uid_42' });
  });

  it('returns null for admin token', async () => {
    const { createSessionToken } = await import('./admin-auth');
    const { verifyUserSession } = await import('./user-auth');
    expect(verifyUserSession(createSessionToken())).toBeNull();
  });
});

describe('getCurrentUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no cookie is present', async () => {
    cookieStore.get.mockReturnValueOnce(undefined);
    const { getCurrentUser } = await import('./user-auth');
    expect(await getCurrentUser()).toBeNull();
  });

  it('returns null when cookie holds an admin token', async () => {
    const { createSessionToken } = await import('./admin-auth');
    cookieStore.get.mockReturnValueOnce({ value: createSessionToken() });
    const { getCurrentUser } = await import('./user-auth');
    expect(await getCurrentUser()).toBeNull();
  });

  it('returns null when user row has been deleted', async () => {
    const { createUserSessionToken } = await import('./user-auth');
    cookieStore.get.mockReturnValueOnce({ value: createUserSessionToken('uid_99') });
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const { getCurrentUser } = await import('./user-auth');
    expect(await getCurrentUser()).toBeNull();
  });

  it('returns the user when token is valid and row exists', async () => {
    const fakeUser = {
      id: 'uid_99',
      username: 'alice',
      displayName: null,
      passwordHash: 'hash',
      isAdmin: false,
      defaultCurrency: null,
      defaultCountry: null,
      preferredAirlines: [],
      cabinClass: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { createUserSessionToken } = await import('./user-auth');
    cookieStore.get.mockReturnValueOnce({ value: createUserSessionToken('uid_99') });
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(fakeUser as never);
    const { getCurrentUser } = await import('./user-auth');
    expect(await getCurrentUser()).toEqual(fakeUser);
  });
});

describe('requireUser / requireAdminUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requireUser throws when no session', async () => {
    cookieStore.get.mockReturnValueOnce(undefined);
    const { requireUser, UnauthorizedError } = await import('./user-auth');
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('requireAdminUser throws ForbiddenError when user is not admin', async () => {
    const { createUserSessionToken } = await import('./user-auth');
    cookieStore.get.mockReturnValueOnce({ value: createUserSessionToken('uid_1') });
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'uid_1', isAdmin: false,
    } as never);
    const { requireAdminUser, ForbiddenError } = await import('./user-auth');
    await expect(requireAdminUser()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('requireAdminUser returns user when isAdmin', async () => {
    const { createUserSessionToken } = await import('./user-auth');
    cookieStore.get.mockReturnValueOnce({ value: createUserSessionToken('uid_1') });
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'uid_1', isAdmin: true,
    } as never);
    const { requireAdminUser } = await import('./user-auth');
    const user = await requireAdminUser();
    expect(user.isAdmin).toBe(true);
  });
});
