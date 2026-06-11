import { cookies, headers } from 'next/headers';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import { verifyHashedPassword } from '@/lib/password';

// "ft-" prefix kept across the Flight Finder rename so existing sessions survive.
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

/**
 * Parses the issue timestamp (ms) out of a verified admin payload
 * (`admin:<ms>`). Returns null when the payload is not an admin token or
 * the timestamp is not a finite number. HMAC verification is the caller's
 * responsibility; this is a pure string parse.
 */
export function parseAdminTokenTimestamp(token: string): number | null {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = token.slice(0, lastDot);
  if (!payload.startsWith('admin:')) return null;
  const ts = Number(payload.slice('admin:'.length));
  if (!Number.isFinite(ts)) return null;
  return ts;
}

export function verifySessionToken(token: string): boolean {
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;

  const payload = token.slice(0, lastDot);
  if (!payload.startsWith('admin:')) return false;

  const sig = token.slice(lastDot + 1);
  if (!verifyPayload(payload, sig)) return false;

  // Server-side expiry: reject tokens older than the cookie maxAge so a stolen
  // or stale cookie cannot be replayed indefinitely once it passes the HMAC.
  const ts = Number(payload.slice('admin:'.length));
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > SESSION_MAX_AGE * 1000) return false;

  return true;
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

/**
 * Whether the cookie should carry the Secure attribute. Keyed off the actual
 * request protocol, NOT NODE_ENV: a self-hosted instance runs NODE_ENV=production
 * but is commonly reached over plain http (http://localhost, a LAN IP). Marking
 * the session cookie Secure there breaks login in browsers that don't treat
 * http://localhost as a secure context -- Safari drops the cookie, so the login
 * 200s but every subsequent request is anonymous and bounces back to /login.
 * Behind an https reverse proxy (Caddy) x-forwarded-proto is "https" and the
 * cookie is correctly marked Secure.
 */
async function requestIsHttps(): Promise<boolean> {
  try {
    const h = await headers();
    const proto = h.get('x-forwarded-proto');
    if (proto) return proto.split(',')[0]!.trim() === 'https';
  } catch {
    // No request scope (e.g. a unit test): fall through to non-secure.
  }
  return false;
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: await requestIsHttps(),
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
  try {
    const jar = await cookies();
    return jar.get(SESSION_COOKIE)?.value;
  } catch {
    // cookies() throws when called outside a request scope (for example a unit
    // test invoking a route handler directly). No request scope means there is
    // no session cookie to read.
    return undefined;
  }
}
