import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSessionToken,
  verifySessionToken,
  verifyPassword,
  signPayload,
  parseAdminTokenTimestamp,
  setSessionCookie,
} from './admin-auth';
import { hashPassword } from './password';

const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 7 * 1000;

/** Builds a correctly-signed admin token with an arbitrary issue timestamp. */
function signedAdminToken(issuedAtMs: number): string {
  const payload = `admin:${issuedAtMs}`;
  return `${payload}.${signPayload(payload)}`;
}

// Mutable state the next/headers mock reads, so each test can vary the request
// protocol and inspect the cookie that was set.
const { mockCookieSet, headerState } = vi.hoisted(() => ({
  mockCookieSet: vi.fn(),
  headerState: { proto: null as string | null },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

// Mock next/headers since admin-auth imports cookies + headers (set/get/clear
// cookie fns, and the request-protocol check that drives the Secure flag).
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: mockCookieSet,
    delete: vi.fn(),
  }),
  headers: vi.fn().mockResolvedValue({
    get: (key: string) => (key === 'x-forwarded-proto' ? headerState.proto : null),
  }),
}));

// Regression: the session cookie's Secure attribute must follow the actual
// request protocol, not NODE_ENV. A self-hosted instance runs in production but
// is commonly reached over http://localhost or a LAN IP, where a Secure cookie
// is silently dropped by Safari -- login 200s, then every request is anonymous
// and bounces back to /login.
describe('setSessionCookie -- Secure flag follows request protocol', () => {
  beforeEach(() => {
    mockCookieSet.mockClear();
    headerState.proto = null;
  });

  it('omits Secure on a plain http request (no x-forwarded-proto)', async () => {
    headerState.proto = null;
    await setSessionCookie('tok');
    expect(mockCookieSet).toHaveBeenCalledWith('ft-session', 'tok', expect.objectContaining({ secure: false, httpOnly: true }));
  });

  it('omits Secure when behind an http proxy', async () => {
    headerState.proto = 'http';
    await setSessionCookie('tok');
    expect(mockCookieSet.mock.calls[0]![2]).toMatchObject({ secure: false });
  });

  it('sets Secure when the request is https (behind an https proxy)', async () => {
    headerState.proto = 'https';
    await setSessionCookie('tok');
    expect(mockCookieSet.mock.calls[0]![2]).toMatchObject({ secure: true });
  });

  it('uses the first proto when the header is a comma list', async () => {
    headerState.proto = 'https, http';
    await setSessionCookie('tok');
    expect(mockCookieSet.mock.calls[0]![2]).toMatchObject({ secure: true });
  });
});

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

  it('accepts a correctly signed token issued just under the max age', () => {
    const token = signedAdminToken(Date.now() - (SESSION_MAX_AGE_MS - 60_000));
    expect(verifySessionToken(token)).toBe(true);
  });

  it('rejects a correctly signed token older than the 7-day max age', () => {
    // Signature is valid, only the embedded timestamp is stale: the
    // server-side expiry must still reject it so a leaked cookie cannot be
    // replayed indefinitely.
    const token = signedAdminToken(Date.now() - (SESSION_MAX_AGE_MS + 60_000));
    expect(verifySessionToken(token)).toBe(false);
  });

  it('rejects a token with a non-numeric timestamp', () => {
    const payload = 'admin:notanumber';
    const token = `${payload}.${signPayload(payload)}`;
    expect(verifySessionToken(token)).toBe(false);
  });
});

describe('parseAdminTokenTimestamp', () => {
  it('returns the embedded timestamp for an admin token', () => {
    const issuedAt = 1_700_000_000_000;
    expect(parseAdminTokenTimestamp(signedAdminToken(issuedAt))).toBe(issuedAt);
  });

  it('returns null for a user token', async () => {
    const { createUserSessionToken } = await import('./user-auth');
    expect(parseAdminTokenTimestamp(createUserSessionToken('uid_x'))).toBeNull();
  });

  it('returns null when there is no dot', () => {
    expect(parseAdminTokenTimestamp('nodot')).toBeNull();
  });

  it('returns null for a non-numeric timestamp', () => {
    const payload = 'admin:nope';
    expect(parseAdminTokenTimestamp(`${payload}.${signPayload(payload)}`)).toBeNull();
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
