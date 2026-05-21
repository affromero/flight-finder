import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { getSessionToken, verifySessionToken } from '@/lib/admin-auth';

export interface AuthResult {
  ok: boolean;
  status?: number;
  error?: string;
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
    if (token && query.deleteToken && query.deleteToken === token) {
      return { ok: true };
    }
    if (user && query.userId && query.userId === user.id) {
      return { ok: true };
    }
    return { ok: false, status: 403, error: 'Not authorized to modify this tracker' };
  }

  // hosted (non-self-hosted) — admin dashboard carries the legacy HMAC cookie.
  const session = await getSessionToken();
  if (session && verifySessionToken(session)) {
    return { ok: true };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, status: 401, error: 'Missing delete token' };
  }
  if (!query.deleteToken || query.deleteToken !== token) {
    return { ok: false, status: 403, error: 'Invalid delete token' };
  }
  return { ok: true };
}
