import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { sharedAccess } from '@/lib/sidedoor/access/service';
import { currentAccessSession } from '@/lib/sidedoor/access/session';

export const dynamic = 'force-dynamic';

/** Household profile names are visible only within an admitted or explicitly open household. */
export async function GET() {
  const state = await sharedAccess.store.read();
  if (state.mode !== 'household') return apiSuccess({ profiles: [] });
  if (!(await currentAccessSession()) && !(await sharedAccess.supportsOpenHousehold()))
    return apiError('Unauthorized', 401);
  const ids = state.principals.filter(principal => principal.pendingRole !== 'owner').map(principal => principal.id);

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    orderBy: [{ isAdmin: 'desc' }, { username: 'asc' }],
    select: { id: true, username: true, displayName: true, avatar: true, isAdmin: true },
  });
  const profiles = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    isAdmin: u.isAdmin && state.principals.some(principal => principal.id === u.id && principal.role === 'owner'),
  }));
  return apiSuccess({ profiles });
}
