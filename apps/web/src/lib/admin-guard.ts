import type { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';

/**
 * Node-side admin guard for /api/admin/* handlers.
 *
 *   - Hosted (SELF_HOSTED unset): Edge middleware gates these via the
 *     admin HMAC cookie, so this guard is a no-op and returns null.
 *   - Self-hosted solo mode (multiUserMode=false): middleware bypasses
 *     admin auth entirely (the deployer owns the box). This guard
 *     stays a no-op to preserve that behavior.
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
  if (!(await isMultiUserEnabled())) return null;
  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);
  if (!user.isAdmin) return apiError('Forbidden', 403);
  return null;
}
