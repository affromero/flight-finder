import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionToken, verifySessionToken, verifyPassword } from './admin-auth';
import { hashPassword } from './password';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

// Mock next/headers since admin-auth imports cookies (used by set/get/clear cookie fns)
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

describe('createSessionToken', () => {
  it('returns payload.signature format', () => {
    const token = createSessionToken();
    expect(token).toMatch(/^admin:\d+\.[0-9a-f]{64}$/);
  });

  it('includes current timestamp', () => {
    const before = Date.now();
    const token = createSessionToken();
    const after = Date.now();
    const timestamp = Number(token.split('.')[0]!.split(':')[1]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('verifySessionToken', () => {
  it('accepts valid token', () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
  });

  it('rejects tampered payload', () => {
    const token = createSessionToken();
    const tampered = 'admin:0' + token.slice(token.indexOf('.'));
    expect(verifySessionToken(tampered)).toBe(false);
  });

  it('rejects tampered signature', () => {
    const token = createSessionToken();
    const flipped = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    expect(verifySessionToken(flipped)).toBe(false);
  });

  it('rejects token without dot', () => {
    expect(verifySessionToken('nodot')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(verifySessionToken('')).toBe(false);
  });

  it('rejects a valid user: token (admin-only verifier)', async () => {
    const { createUserSessionToken } = await import('./user-auth');
    const userToken = createUserSessionToken('uid_x');
    expect(verifySessionToken(userToken)).toBe(false);
  });
});

describe('verifyPassword', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_PASSWORD = 'test-admin-pw';
  });

  it('matches env var when no db hash exists', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue(null);
    expect(await verifyPassword('test-admin-pw')).toBe(true);
  });

  it('rejects wrong password against env var', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue(null);
    expect(await verifyPassword('wrong-password')).toBe(false);
  });

  it('checks db hash first when available', async () => {
    const hash = await hashPassword('db-password');
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue({
      id: 'singleton',
      adminPasswordHash: hash,
    } as never);
    expect(await verifyPassword('db-password')).toBe(true);
  });

  it('rejects wrong password against db hash', async () => {
    const hash = await hashPassword('db-password');
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue({
      id: 'singleton',
      adminPasswordHash: hash,
    } as never);
    expect(await verifyPassword('wrong')).toBe(false);
  });

  it('returns false when no hash and no env var', async () => {
    delete process.env.ADMIN_PASSWORD;
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.extractionConfig.findUnique).mockResolvedValue(null);
    expect(await verifyPassword('anything')).toBe(false);
  });
});
