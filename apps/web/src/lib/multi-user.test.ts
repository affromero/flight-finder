import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMock = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
};

vi.mock('@/lib/redis', () => ({
  redis: redisMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findUnique: vi.fn(),
    },
  },
}));

describe('isMultiUserEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces newly enabled accounts despite a stale solo-mode Redis entry', async () => {
    process.env.SELF_HOSTED = 'true';
    redisMock.get.mockResolvedValue('false');
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValueOnce({ multiUserMode: false } as never)
      .mockResolvedValueOnce({ multiUserMode: true } as never);
    const { isMultiUserEnabled } = await import('./multi-user');
    expect(await isMultiUserEnabled()).toBe(false);
    expect(await isMultiUserEnabled()).toBe(true);
  });

  it('surfaces database failures instead of granting solo access', async () => {
    process.env.SELF_HOSTED = 'true';
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockRejectedValueOnce(new Error('database unavailable'));
    const { isMultiUserEnabled } = await import('./multi-user');
    await expect(isMultiUserEnabled()).rejects.toThrow('database unavailable');
  });

  it('returns false when SELF_HOSTED is unset', async () => {
    delete process.env.SELF_HOSTED;
    const { isMultiUserEnabled } = await import('./multi-user');
    expect(await isMultiUserEnabled()).toBe(false);
  });

  it('returns false when SELF_HOSTED is anything other than "true"', async () => {
    process.env.SELF_HOSTED = 'false';
    const { isMultiUserEnabled } = await import('./multi-user');
    expect(await isMultiUserEnabled()).toBe(false);
  });

  it('returns false when SELF_HOSTED=true but multiUserMode is false', async () => {
    process.env.SELF_HOSTED = 'true';
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue({
      multiUserMode: false,
    } as never);
    const { isMultiUserEnabled } = await import('./multi-user');
    expect(await isMultiUserEnabled()).toBe(false);
  });

  it('returns true when SELF_HOSTED=true and multiUserMode is true', async () => {
    process.env.SELF_HOSTED = 'true';
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue({
      multiUserMode: true,
    } as never);
    const { isMultiUserEnabled } = await import('./multi-user');
    expect(await isMultiUserEnabled()).toBe(true);
  });

  it('returns false when SELF_HOSTED=true and config row is missing', async () => {
    process.env.SELF_HOSTED = 'true';
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue(null);
    const { isMultiUserEnabled } = await import('./multi-user');
    expect(await isMultiUserEnabled()).toBe(false);
  });

  it('does not query the DB when SELF_HOSTED is unset (hard gate)', async () => {
    delete process.env.SELF_HOSTED;
    const { prisma } = await import('@/lib/prisma');
    const { isMultiUserEnabled } = await import('./multi-user');
    await isMultiUserEnabled();
    expect(prisma.extractionConfig.findUnique).not.toHaveBeenCalled();
  });
});

describe('invalidateMultiUserCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls redis.del on the cache key', async () => {
    const { invalidateMultiUserCache } = await import('./multi-user');
    await invalidateMultiUserCache();
    expect(redisMock.del).toHaveBeenCalledWith('ft:multi-user');
  });

  it('swallows Redis errors', async () => {
    redisMock.del.mockRejectedValueOnce(new Error('Redis down'));
    const { invalidateMultiUserCache } = await import('./multi-user');
    await expect(invalidateMultiUserCache()).resolves.toBeUndefined();
  });
});
