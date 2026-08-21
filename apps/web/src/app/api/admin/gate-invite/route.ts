import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { createInviteToken, gateEnabled } from '@/lib/access/gate';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';

export const dynamic = 'force-dynamic';

/**
 * Mint a single-use-in-practice invite link for the access gate.
 *
 * Deliberately NOT protected by requireAdminApi(): in self-hosted solo mode that
 * guard authorizes everyone, because the deployer is assumed to own the box.
 * That assumption breaks here — on a gated instance, "everyone" means anyone who
 * got through the gate, and handing them the power to invite others would make
 * the gate decorative. So this route insists on multi-user mode, where an actual
 * admin identity exists to check.
 */
export async function POST(request: NextRequest) {
  if (!gateEnabled()) return apiError('This instance is not gated', 404);

  if (!(await isMultiUserEnabled())) {
    return apiError(
      'Turn on multi-user mode first: invites need a real admin account to issue them.',
      409,
    );
  }

  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);
  if (!user.isAdmin) return apiError('Forbidden', 403);

  const token = await createInviteToken();
  if (!token) return apiError('Gate misconfigured', 500);

  // Build the link against the host the admin is actually using, so an instance
  // reached over Tailscale or a LAN address produces a link that resolves there.
  const origin = new URL(request.url).origin;
  return apiSuccess({ url: `${origin}/gate?t=${encodeURIComponent(token)}` });
}
