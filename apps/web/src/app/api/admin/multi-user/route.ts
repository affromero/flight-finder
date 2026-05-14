import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { invalidateMultiUserCache } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { verifySessionToken, getSessionToken } from '@/lib/admin-auth';

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
export async function POST(request: NextRequest) {
  if (process.env.SELF_HOSTED !== 'true') {
    return apiError('Multi user mode is only available in self-hosted deployments', 400);
  }

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

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: adminUsername,
        displayName,
        passwordHash,
        isAdmin: true,
      },
    });

    await tx.extractionConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', multiUserMode: true },
      update: { multiUserMode: true },
    });

    const backfill = await tx.query.updateMany({
      where: { userId: null, isSeed: false },
      data: { userId: user.id },
    });

    return { user, backfillCount: backfill.count };
  });

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
