import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';

const ALLOWED_INTERVALS = [1, 3, 6, 12, 24];

interface AuthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Authorize a mutation on `query` for the current request. The rules:
 *
 *   - hosted (SELF_HOSTED unset): require a matching deleteToken (existing
 *     behavior, public users own their queries via the cookie they get back
 *     at create time)
 *   - self hosted solo mode (multiUserMode off): no token check; whoever has
 *     access to the box owns everything (existing behavior)
 *   - self hosted multi user mode: admin session OR matching deleteToken OR
 *     matching user session whose userId equals query.userId. Queries with
 *     no owner (e.g. seeds) are admin only.
 */
async function authorizeMutation(
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

  if (!token || typeof token !== 'string') {
    return { ok: false, status: 401, error: 'Missing delete token' };
  }
  if (!query.deleteToken || query.deleteToken !== token) {
    return { ok: false, status: 403, error: 'Invalid delete token' };
  }
  return { ok: true };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;

  const query = await prisma.query.findUnique({
    where: { id },
    select: { deleteToken: true, groupId: true, userId: true },
  });

  if (!query) return apiError('Tracker not found', 404);

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);

  // Accept null (means "follow global") or one of the allowed numeric intervals.
  let interval: number | null;
  if (body.scrapeInterval === null) {
    interval = null;
  } else {
    interval = Number(body.scrapeInterval);
    if (!ALLOWED_INTERVALS.includes(interval)) {
      return apiError(`scrapeInterval must be null or one of: ${ALLOWED_INTERVALS.join(', ')}`, 400);
    }
  }

  // Update this query and all siblings in the group
  const idsToUpdate = [id];
  if (query.groupId) {
    const siblings = await prisma.query.findMany({
      where: { groupId: query.groupId, id: { not: id } },
      select: { id: true },
    });
    idsToUpdate.push(...siblings.map((s) => s.id));
  }

  await prisma.query.updateMany({
    where: { id: { in: idsToUpdate } },
    data: { scrapeInterval: interval },
  });

  return apiSuccess({ scrapeInterval: interval, updated: idsToUpdate.length });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;

  const query = await prisma.query.findUnique({
    where: { id },
    select: { deleteToken: true, userId: true },
  });

  if (!query) {
    return apiError('Tracker not found', 404);
  }

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);

  await prisma.query.delete({ where: { id } });

  return apiSuccess({ deleted: true });
}
