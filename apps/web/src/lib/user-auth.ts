import { cookies } from 'next/headers';
import type { User } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import {
  SESSION_COOKIE,
  signPayload,
  verifyPayload,
} from '@/lib/admin-auth';

// Absolute upper bound on how old a user session token may be, regardless of
// whether the HMAC is valid and sessionsValidFrom has not advanced. Mirrors the
// admin 7-day cookie maxAge so both token kinds share the same expiry policy.
// Can be overridden via SESSION_MAX_AGE (seconds) for testing or tighter policy.
const SESSION_MAX_AGE_MS = (() => {
  const override = Number(process.env.SESSION_MAX_AGE);
  return Number.isFinite(override) && override > 0
    ? override * 1000
    : 60 * 60 * 24 * 7 * 1000; // 7 days
})();

export type ParsedSession =
  | { kind: 'admin'; ts: number }
  | { kind: 'user'; userId: string; ts: number }
  | null;

export function parseSession(token: string): ParsedSession {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!verifyPayload(payload, sig)) return null;

  if (payload.startsWith('admin:')) {
    const ts = Number(payload.slice('admin:'.length));
    if (!Number.isFinite(ts)) return null;
    return { kind: 'admin', ts };
  }

  if (payload.startsWith('user:')) {
    const rest = payload.slice('user:'.length);
    const sep = rest.lastIndexOf(':');
    if (sep <= 0) return null;
    const userId = rest.slice(0, sep);
    const ts = Number(rest.slice(sep + 1));
    if (!userId || !Number.isFinite(ts)) return null;
    return { kind: 'user', userId, ts };
  }

  return null;
}

export function createUserSessionToken(userId: string): string {
  const payload = `user:${userId}:${Date.now()}`;
  return `${payload}.${signPayload(payload)}`;
}

export function verifyUserSession(token: string): { userId: string } | null {
  const parsed = parseSession(token);
  if (!parsed || parsed.kind !== 'user') return null;
  return { userId: parsed.userId };
}

/**
 * Reads the session cookie, parses it as a user token, and looks up the user
 * row in the DB. Returns null for any failure (no cookie, admin token, deleted
 * user, etc.). The DB lookup ensures deleted users lose access immediately —
 * stateless HMAC tokens alone would otherwise stay valid for 7 days.
 */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const parsed = parseSession(token);
  if (!parsed || parsed.kind !== 'user') return null;
  // Absolute max-age guard: reject tokens that are older than SESSION_MAX_AGE_MS
  // even when the HMAC is valid. This prevents indefinite replay of a stolen or
  // leaked cookie that was never explicitly revoked.
  if (Date.now() - parsed.ts > SESSION_MAX_AGE_MS) return null;
  const user = await prisma.user.findUnique({ where: { id: parsed.userId } });
  if (!user) return null;
  // Revoke any session issued before the user's last password change/reset.
  if (user.sessionsValidFrom && parsed.ts < user.sessionsValidFrom.getTime()) return null;
  return user;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireAdminUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  if (!user.isAdmin) throw new ForbiddenError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('Forbidden');
    this.name = 'ForbiddenError';
  }
}
