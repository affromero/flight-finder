import type { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import {
  getSessionToken,
  verifySessionToken,
  parseAdminTokenTimestamp,
} from '@/lib/admin-auth';

/**
 * Internal tri-state for the admin cookie: distinguishes "no admin cookie at
 * all" (callers fall through to other auth) from "admin cookie present but
 * revoked" (callers must reject). 'valid' means HMAC + 7-day expiry +
 * adminSessionsValidFrom all pass.
 */
type AdminSessionState = 'absent' | 'revoked' | 'valid';

async function readAdminSessionState(): Promise<AdminSessionState> {
  const token = await getSessionToken();
  // No admin HMAC cookie (no cookie, a forged signature, an expired token, or a
  // user: token): treat as absent so callers can fall through to their other
  // auth paths instead of returning a hard 401.
  if (!token || !verifySessionToken(token)) return 'absent';
  const ts = parseAdminTokenTimestamp(token);
  if (ts === null) return 'absent';

  const config = await prisma.extractionConfig.findUnique({
    where: { id: 'singleton' },
    select: { adminSessionsValidFrom: true },
  });
  if (config?.adminSessionsValidFrom && ts < config.adminSessionsValidFrom.getTime()) {
    return 'revoked';
  }
  return 'valid';
}

/**
 * Authoritative (DB-backed) admin session check used everywhere an admin HMAC
 * cookie authorizes behavior. Verifies HMAC + 7-day expiry (verifySessionToken)
 * AND that the token was not issued before ExtractionConfig.adminSessionsValidFrom
 * (stamped on every admin password change). The Edge middleware can verify the
 * HMAC and expiry but cannot reach the database, so the "invalidate every admin
 * session on password change" guarantee lives here, mirroring how user sessions
 * use User.sessionsValidFrom in lib/user-auth.ts.
 *
 * Returns true only when a valid, non-revoked admin token is present. Returns
 * false when there is no admin cookie, the HMAC/expiry check fails, or the token
 * predates the last password change. Use this instead of a bare
 * verifySessionToken anywhere an admin cookie grants access.
 */
export async function verifyAdminSessionRevocable(): Promise<boolean> {
  return (await readAdminSessionState()) === 'valid';
}

/**
 * Authoritative (DB-backed) revocation check for the legacy admin HMAC
 * session. Returns a 401 response when the caller presents an admin token that
 * was issued before ExtractionConfig.adminSessionsValidFrom. Returns null when
 * there is no admin token (e.g. a user-token caller in multi user mode) or
 * the admin token is still valid.
 */
async function rejectRevokedAdminToken(): Promise<NextResponse | null> {
  return (await readAdminSessionState()) === 'revoked' ? apiError('Unauthorized', 401) : null;
}

/**
 * Node-side admin guard for /api/admin/* handlers.
 *
 *   - Hosted (SELF_HOSTED unset): Edge middleware gates these via the
 *     admin HMAC cookie. This guard additionally rejects admin tokens
 *     revoked by a password change (the middleware cannot reach the DB).
 *   - Self-hosted solo mode (multiUserMode=false): middleware bypasses
 *     admin auth entirely (the deployer owns the box). The revocation
 *     check still applies when an admin token is present.
 *   - Self-hosted multi user mode (multiUserMode=true): middleware
 *     still bypasses (because SELF_HOSTED is true), but non-admin
 *     household members would otherwise be able to hit /api/admin/*
 *     directly. This guard rejects them.
 *
 * Returns null when authorized, or a NextResponse with 401/403 when
 * not. Call this at the top of every /api/admin/* handler that isn't
 * itself the auth bootstrap (login, multi-user toggle).
 */
export async function requireAdminApi(): Promise<NextResponse | null> {
  const revoked = await rejectRevokedAdminToken();
  if (revoked) return revoked;

  if (!(await isMultiUserEnabled())) return null;
  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);
  if (!user.isAdmin) return apiError('Forbidden', 403);
  return null;
}
