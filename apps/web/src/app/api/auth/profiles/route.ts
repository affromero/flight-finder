import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { sharedAccess } from '@/lib/sidedoor/access/service';
import { currentAccessSession } from '@/lib/sidedoor/access/session';

export const dynamic = 'force-dynamic';

/** Household profile names are visible only within an admitted or explicitly open household. */
export async function GET() {
  if (!(await isMultiUserEnabled())) return apiError('Not found', 404);

  const state = await sharedAccess.store.read();
  if (state.mode !== 'household') return apiSuccess({ profiles: [] });
  if (!(await currentAccessSession()) && !(await sharedAccess.supportsOpenHousehold()))
    return apiError('Unauthorized', 401);
  const ids = state.principals.filter(principal => principal.pendingRole !== 'owner').map(principal => principal.id);

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    orderBy: [{ isAdmin: 'desc' }, { username: 'asc' }],
    select: { id: true, username: true, displayName: true, avatar: true },
  });
  const profiles = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    hasPassword:
      state.principals.find(principal => principal.id === u.id)?.passwordHash !== null ||
      state.passkeys.some(key => key.principalId === u.id),
  }));
  return apiSuccess({ profiles });
}
