import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import { verifyHashedPassword } from '@/lib/password';

export const SESSION_COOKIE = 'ft-session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');
  return secret;
}

export function signPayload(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('hex');
}

export function verifyPayload(payload: string, sig: string): boolean {
  const expected = signPayload(payload);
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function createSessionToken(): string {
  const payload = `admin:${Date.now()}`;
  return `${payload}.${signPayload(payload)}`;
}

export function verifySessionToken(token: string): boolean {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;

  const payload = token.slice(0, lastDot);
  if (!payload.startsWith('admin:')) return false;

  const sig = token.slice(lastDot + 1);
  return verifyPayload(payload, sig);
}

export async function verifyPassword(
  input: string,
  opts: { allowEnvFallback?: boolean } = {},
): Promise<boolean> {
  const allowEnvFallback = opts.allowEnvFallback ?? true;

  const config = await prisma.extractionConfig.findUnique({
    where: { id: 'singleton' },
    select: { adminPasswordHash: true },
  });

  if (config?.adminPasswordHash) {
    return verifyHashedPassword(input, config.adminPasswordHash);
  }

  if (!allowEnvFallback) return false;

  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;

  try {
    return timingSafeEqual(
      Buffer.from(input, 'utf8'),
      Buffer.from(password, 'utf8')
    );
  } catch {
    return false;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function getSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}
