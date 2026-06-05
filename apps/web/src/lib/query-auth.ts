import { timingSafeEqual } from 'node:crypto';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
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

/**
 * Authorize a mutation on `query` for the current request. The rules:
 *
 *   - hosted (SELF_HOSTED unset): require a matching deleteToken, OR a valid
 *     legacy admin HMAC session cookie (operators managing every tracker via
 *     the admin dashboard).
 *   - self hosted solo mode (multiUserMode off): no token check; whoever has
 *     access to the box owns everything.
 *   - self hosted multi user mode: admin session OR matching deleteToken OR
 *     matching user session whose userId equals query.userId. Queries with
 *     no owner (e.g. seeds) are admin only.
 *
 * Exported so the /api/queries/[id] PATCH/DELETE handlers and the new
 * /api/queries/[id]/scrape POST handler share one auth surface.
 */
export async function authorizeMutation(
  query: { deleteToken: string | null; userId?: string | null },
  token: string | undefined | null,
): Promise<AuthResult> {
  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const multiUser = isSelfHosted ? await isMultiUserEnabled() : false;

  if (isSelfHosted && !multiUser) {
    return { ok: true };
  }

  if (multiUser) {
    const user = await getCurrentUser();
    if (user?.isAdmin) return { ok: true };
    if (deleteTokensMatch(query.deleteToken, token)) {
      return { ok: true };
    }
    if (user && query.userId && query.userId === user.id) {
      return { ok: true };
    }
    return { ok: false, status: 403, error: 'Not authorized to modify this tracker' };
  }

  // hosted (non-self-hosted) — admin dashboard carries the legacy HMAC cookie.
  // Use the revocation-aware check so a token issued before the last admin
  // password change (adminSessionsValidFrom) is rejected here too, not just by
  // verifySessionToken's HMAC + expiry.
  if (await verifyAdminSessionRevocable()) {
    return { ok: true };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, status: 401, error: 'Missing delete token' };
  }
  if (!deleteTokensMatch(query.deleteToken, token)) {
    return { ok: false, status: 403, error: 'Invalid delete token' };
  }
  return { ok: true };
}

/**
 * Whether the current request can manage `query` WITHOUT presenting a delete
 * token. Used by the public tracker page to decide which edit affordances to
 * render server-side, so a localStorage-less browser (e.g. after a machine
 * migration) still surfaces the controls the backend would accept.
 *
 * Mirrors `authorizeMutation` minus the deleteToken branch:
 *   - self hosted solo mode: anyone with box access manages everything.
 *   - multi user mode: admin session, or the owning user.
 *   - pure hosted mode: never (token is the only key), so anonymous visitors
 *     keep the existing token-gated behavior.
 */
export async function canManageQueryWithoutToken(
  query: { userId?: string | null },
): Promise<boolean> {
  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const multiUser = isSelfHosted ? await isMultiUserEnabled() : false;

  if (isSelfHosted && !multiUser) return true;

  if (multiUser) {
    const user = await getCurrentUser();
    if (user?.isAdmin) return true;
    if (user && query.userId && query.userId === user.id) return true;
    return false;
  }

  return false;
}
