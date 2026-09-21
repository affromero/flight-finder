import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { invalidateMultiUserCache, isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { requireAdminApi } from '@/lib/admin-guard';
import { disableMultiUserMode } from '@/lib/admin-recovery';
import { readAccessJson } from 'thesidedoor-core/access/http';
import { cookies } from 'next/headers';
import { SHARED_SESSION_COOKIE } from '@/lib/sidedoor/access/service';
import { isAccessError } from 'thesidedoor-core/access';
import { migrateSoloOwnership } from '@/lib/account-migration';

class AlreadyEnabledError extends Error {}

/** Enable household profiles using the claimed owner and preserve existing tracker ownership. */
export async function POST(request: Request) {
  if (process.env.SELF_HOSTED !== 'true') return apiError('Multi user mode is only available in self-hosted deployments', 400);
  const owner = await getCurrentUser();
  if (!owner) return apiError('Unauthorized', 401);
  if (!owner.isAdmin) return apiError('Forbidden', 403);
  const body = await readAccessJson(request).catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
    return apiError('Send an empty object. The current owner account is retained.', 400);
  try {
    const backfillCount = await prisma.$transaction(async tx => {
      await tx.extractionConfig.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} });
      const flip = await tx.extractionConfig.updateMany({ where: { id: 'singleton', multiUserMode: false }, data: { multiUserMode: true } });
      if (!flip.count) throw new AlreadyEnabledError();
      return migrateSoloOwnership(tx, owner.id);
    });
    await invalidateMultiUserCache();
    return apiSuccess({ user: { id: owner.id, username: owner.username, displayName: owner.displayName, avatar: owner.avatar, isAdmin: true }, backfillCount }, 201);
  } catch (error) {
    if (error instanceof AlreadyEnabledError) return apiError('Multi user mode is already enabled', 409);
    throw error;
  }
}

export async function DELETE() {
  if (process.env.SELF_HOSTED !== 'true') return apiError('Multi user mode is only available in self-hosted deployments', 400);
  const denial = await requireAdminApi();
  if (denial) return denial;
  if (!(await isMultiUserEnabled())) return apiError('Multi user mode is not enabled', 404);
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return apiError('Unauthorized', 401);
  try { await disableMultiUserMode(token); }
  catch (error) {
    if (isAccessError(error)) return apiError(error.code, error.code === 'unauthorized' ? 401 : 403);
    throw error;
  }
  return apiSuccess({ disabled: true });
}
