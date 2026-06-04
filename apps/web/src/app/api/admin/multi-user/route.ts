import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { invalidateMultiUserCache, isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { verifySessionToken, getSessionToken } from '@/lib/admin-auth';
import { requireAdminApi } from '@/lib/admin-guard';
import { disableMultiUserMode } from '@/lib/admin-recovery';

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;

interface ToggleBody {
  adminUsername?: unknown;
  adminPassword?: unknown;
  displayName?: unknown;
}

/**
 * Enable multi user mode and create the first admin user atomically.
 *
 *   1. Hash the password
 *   2. Create the User row (isAdmin = true)
 *   3. Flip ExtractionConfig.multiUserMode = true
 *   4. Backfill: assign all unowned non-seed Query rows to the new admin
 *   5. Invalidate the multi-user cache
 *
 * Returns the new user and the backfill count. The caller is expected to
 * surface the count on a one-time banner so the admin can reassign queries
 * that belong to other household members.
 *
 * Authorization: this endpoint must be reachable BEFORE the User table has
 * any rows (it bootstraps the first user). We accept either:
 *   - a valid admin (legacy HMAC) session, OR
 *   - SELF_HOSTED solo mode (middleware bypasses admin auth there anyway)
 * Once multi user mode is on, this route is a no-op and returns 409.
 */
class AlreadyEnabledError extends Error {
  constructor() {
    super('Multi user mode is already enabled');
    this.name = 'AlreadyEnabledError';
  }
}

export async function POST(request: NextRequest) {
  if (process.env.SELF_HOSTED !== 'true') {
    return apiError('Multi user mode is only available in self-hosted deployments', 400);
  }

  // Early read for the fast-path 409. The authoritative check is inside the
  // transaction (guarded `updateMany` on multiUserMode=false) so concurrent
  // enables can't both pass.
  const cfg = await prisma.extractionConfig.findUnique({
    where: { id: 'singleton' },
    select: { multiUserMode: true },
  });
  if (cfg?.multiUserMode) {
    return apiError('Multi user mode is already enabled', 409);
  }

  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  const token = await getSessionToken();
  const adminSession = token ? verifySessionToken(token) : false;
  const userSession = await getCurrentUser();
  const isAdminCaller = adminSession || userSession?.isAdmin === true;
  if (!isAdminCaller && !isSelfHosted) {
    return apiError('Unauthorized', 401);
  }

  const body = (await request.json().catch(() => null)) as ToggleBody | null;
  if (!body) return apiError('Invalid JSON body', 400);

  const adminUsername = typeof body.adminUsername === 'string' ? body.adminUsername.trim() : '';
  const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';
  const displayName =
    typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim()
      : null;

  if (!USERNAME_PATTERN.test(adminUsername)) {
    return apiError('Username must be 2 to 32 characters of letters, numbers, underscores, dots, or dashes', 400);
  }
  if (adminPassword.length < MIN_PASSWORD_LENGTH) {
    return apiError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  const passwordHash = await hashPassword(adminPassword);

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Ensure the singleton row exists, then atomically flip multiUserMode
      // only when it is currently false. If two concurrent calls reach here,
      // exactly one updateMany returns count=1; the other returns 0 and we
      // bail out.
      await tx.extractionConfig.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton' },
        update: {},
      });
      const flip = await tx.extractionConfig.updateMany({
        where: { id: 'singleton', multiUserMode: false },
        data: { multiUserMode: true },
      });
      if (flip.count === 0) throw new AlreadyEnabledError();

      const user = await tx.user.create({
        data: {
          username: adminUsername,
          displayName,
          passwordHash,
          isAdmin: true,
        },
      });

      const backfill = await tx.query.updateMany({
        where: { userId: null, isSeed: false },
        data: { userId: user.id },
      });

      return { user, backfillCount: backfill.count };
    });
  } catch (err) {
    if (err instanceof AlreadyEnabledError) {
      return apiError('Multi user mode is already enabled', 409);
    }
    throw err;
  }

  await invalidateMultiUserCache();

  return apiSuccess(
    {
      user: {
        id: result.user.id,
        username: result.user.username,
        displayName: result.user.displayName,
        isAdmin: result.user.isAdmin,
      },
      backfillCount: result.backfillCount,
    },
    201,
  );
}

/**
 * Turn multi user mode off. Reverts the instance to solo self-hosted: the flag
 * flips to false and the dormant legacy admin hash is cleared, so the app stops
 * requiring a login (SELF_HOSTED middleware bypasses admin auth). User rows are
 * NOT deleted — they remain in the DB and reactivate if multi user mode is
 * re-enabled — they simply become inaccessible while it is off.
 *
 * Authorization: must be an authenticated admin. Unlike POST (which bootstraps
 * the first admin and therefore cannot require one), this is gated by
 * requireAdminApi so a non-admin household member cannot wipe the admin
 * credential and open the instance.
 */
export async function DELETE() {
  if (process.env.SELF_HOSTED !== 'true') {
    return apiError('Multi user mode is only available in self-hosted deployments', 400);
  }
  if (!(await isMultiUserEnabled())) {
    return apiError('Multi user mode is not enabled', 404);
  }
  const denial = await requireAdminApi();
  if (denial) return denial;

  await disableMultiUserMode();
  return apiSuccess({ disabled: true });
}
