import { cookies } from 'next/headers';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  SESSION_COOKIE,
  signPayload,
  verifyPayload,
} from '@/lib/admin-auth';

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
  return prisma.user.findUnique({ where: { id: parsed.userId } });
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
