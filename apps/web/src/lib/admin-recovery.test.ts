import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidateMultiUserCache = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/multi-user', () => ({
  invalidateMultiUserCache: () => invalidateMultiUserCache(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    extractionConfig: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('resetUserPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a scrypt salt:hex hash for an existing user and reports admin status', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1', isAdmin: true } as never);

    const { resetUserPassword } = await import('./admin-recovery');
    const result = await resetUserPassword('garry', 'correcthorse');

    expect(result).toEqual({ ok: true, isAdmin: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        passwordHash: expect.stringMatching(/^[0-9a-f]+:[0-9a-f]+$/),
        sessionsValidFrom: expect.any(Date),
      },
    });
  });

  it('rejects a password shorter than the minimum without touching the DB', async () => {
    const { prisma } = await import('@/lib/prisma');
    const { resetUserPassword } = await import('./admin-recovery');

    const result = await resetUserPassword('garry', 'short');

    expect(result.ok).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('returns ok:false and does not update when the user does not exist', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const { resetUserPassword } = await import('./admin-recovery');
    const result = await resetUserPassword('ghost', 'correcthorse');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ghost/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('disableMultiUserMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flips the flag off, clears the legacy admin hash, and invalidates the cache', async () => {
    const { prisma } = await import('@/lib/prisma');
    const { disableMultiUserMode } = await import('./admin-recovery');

    await disableMultiUserMode();

    expect(prisma.extractionConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', multiUserMode: false, adminPasswordHash: null },
      update: { multiUserMode: false, adminPasswordHash: null },
    });
    expect(invalidateMultiUserCache).toHaveBeenCalledTimes(1);
  });
});
