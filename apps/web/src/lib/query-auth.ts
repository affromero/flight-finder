import { timingSafeEqual } from 'node:crypto';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentProfile } from '@/lib/user-auth';
import { verifyAdminSessionRevocable } from '@/lib/admin-guard';

export interface AuthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Constant-time delete-token comparison. A plain === leaks, byte by byte via
 * timing, how much of a guessed token is correct. Length is compared first
 * (timingSafeEqual throws on unequal-length buffers); that only reveals the
 * token length, which is not secret.
 */
function deleteTokensMatch(stored: string | null | undefined, provided: string | null | undefined): boolean {
  if (!stored || !provided) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Owners, matching tracker capabilities, and selected multiuser profiles may mutate trackers. */
export async function authorizeMutation(
  query: { deleteToken: string | null; userId?: string | null },
  token: string | undefined | null,
): Promise<AuthResult> {
  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const multiUser = isSelfHosted ? await isMultiUserEnabled() : false;

  if (await verifyAdminSessionRevocable()) return { ok: true };

  if (multiUser) {
    const user = await getCurrentProfile();
    if (user?.isAdmin) return { ok: true };
    if (deleteTokensMatch(query.deleteToken, token)) {
      return { ok: true };
    }
    if (user && query.userId && query.userId === user.id) {
      return { ok: true };
    }
    return { ok: false, status: 403, error: 'Not authorized to modify this tracker' };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, status: 401, error: 'Missing delete token' };
  }
  if (!deleteTokensMatch(query.deleteToken, token)) {
    return { ok: false, status: 403, error: 'Invalid delete token' };
  }
  return { ok: true };
}

/** Render editing controls only when the server can authorize without a tracker capability. */
export async function canManageQueryWithoutToken(
  query: { userId?: string | null },
): Promise<boolean> {
  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const multiUser = isSelfHosted ? await isMultiUserEnabled() : false;

  if (await verifyAdminSessionRevocable()) return true;

  if (multiUser) {
    const user = await getCurrentProfile();
    if (user?.isAdmin) return true;
    if (user && query.userId && query.userId === user.id) return true;
    return false;
  }

  return false;
}
