import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMock = {
  incr: vi.fn(),
  expire: vi.fn(),
  get: vi.fn(),
  ttl: vi.fn(),
  del: vi.fn(),
};

vi.mock('@/lib/redis', () => ({
  redis: redisMock,
}));

describe('incrementAuthFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments the counter and sets TTL on first failure', async () => {
    redisMock.incr.mockResolvedValueOnce(1);
    redisMock.expire.mockResolvedValueOnce(1);
    const { incrementAuthFailure } = await import('./rate-limit');
    const count = await incrementAuthFailure('1.2.3.4:alice');
    expect(count).toBe(1);
    expect(redisMock.incr).toHaveBeenCalledWith('auth-fail:1.2.3.4:alice');
    expect(redisMock.expire).toHaveBeenCalledWith('auth-fail:1.2.3.4:alice', 15 * 60);
  });

  it('does not reset TTL on subsequent failures', async () => {
    redisMock.incr.mockResolvedValueOnce(2);
    const { incrementAuthFailure } = await import('./rate-limit');
    const count = await incrementAuthFailure('1.2.3.4:alice');
    expect(count).toBe(2);
    expect(redisMock.expire).not.toHaveBeenCalled();
  });

  it('returns 0 when Redis throws (fail-open)', async () => {
    redisMock.incr.mockRejectedValueOnce(new Error('Redis down'));
    const { incrementAuthFailure } = await import('./rate-limit');
    expect(await incrementAuthFailure('key')).toBe(0);
  });

  it('honors custom TTL', async () => {
    redisMock.incr.mockResolvedValueOnce(1);
    const { incrementAuthFailure } = await import('./rate-limit');
    await incrementAuthFailure('key', 30);
    expect(redisMock.expire).toHaveBeenCalledWith('auth-fail:key', 30);
  });
});

describe('getAuthFailureCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns parsed count', async () => {
    redisMock.get.mockResolvedValueOnce('5');
    const { getAuthFailureCount } = await import('./rate-limit');
    expect(await getAuthFailureCount('key')).toBe(5);
  });

  it('returns 0 when no key set', async () => {
    redisMock.get.mockResolvedValueOnce(null);
    const { getAuthFailureCount } = await import('./rate-limit');
    expect(await getAuthFailureCount('key')).toBe(0);
  });

  it('returns 0 on Redis error', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('boom'));
    const { getAuthFailureCount } = await import('./rate-limit');
    expect(await getAuthFailureCount('key')).toBe(0);
  });
});

describe('getRetryAfterSeconds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns positive TTL', async () => {
    redisMock.ttl.mockResolvedValueOnce(300);
    const { getRetryAfterSeconds } = await import('./rate-limit');
    expect(await getRetryAfterSeconds('key')).toBe(300);
  });

  it('returns 0 when key has no TTL', async () => {
    redisMock.ttl.mockResolvedValueOnce(-1);
    const { getRetryAfterSeconds } = await import('./rate-limit');
    expect(await getRetryAfterSeconds('key')).toBe(0);
  });
});

describe('clearAuthFailures', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the counter', async () => {
    redisMock.del.mockResolvedValueOnce(1);
    const { clearAuthFailures } = await import('./rate-limit');
    await clearAuthFailures('key');
    expect(redisMock.del).toHaveBeenCalledWith('auth-fail:key');
  });

  it('swallows Redis errors', async () => {
    redisMock.del.mockRejectedValueOnce(new Error('boom'));
    const { clearAuthFailures } = await import('./rate-limit');
    await expect(clearAuthFailures('key')).resolves.toBeUndefined();
  });
});
