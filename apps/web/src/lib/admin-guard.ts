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
 * Authoritative (DB-backed) revocation check for the legacy admin HMAC
 * session. The Edge middleware verifies the cookie's HMAC and expiry but
 * cannot reach the database, so the "invalidate every admin session on
 * password change" guarantee lives here, mirroring how user sessions use
 * User.sessionsValidFrom in lib/user-auth.ts.
 *
 * Returns a 401 response when the caller presents an admin token that was
 * issued before ExtractionConfig.adminSessionsValidFrom. Returns null when
 * there is no admin token (e.g. a user-token caller in multi user mode) or
 * the admin token is still valid.
 */
async function rejectRevokedAdminToken(): Promise<NextResponse | null> {
  const token = await getSessionToken();
  if (!token || !verifySessionToken(token)) return null;
  const ts = parseAdminTokenTimestamp(token);
  if (ts === null) return null;

  const config = await prisma.extractionConfig.findUnique({
    where: { id: 'singleton' },
    select: { adminSessionsValidFrom: true },
  });
  if (config?.adminSessionsValidFrom && ts < config.adminSessionsValidFrom.getTime()) {
    return apiError('Unauthorized', 401);
  }
  return null;
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
