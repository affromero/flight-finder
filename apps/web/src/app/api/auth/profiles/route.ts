import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';

export const dynamic = 'force-dynamic';

/**
 * Profiles for the Netflix-style login picker. Multi user mode is hard gated on
 * SELF_HOSTED, so this only exists on self-hosted instances. It is intentionally
 * unauthenticated and enumerates accounts (id, name, avatar) -- the login screen
 * needs the list to render the picker, which is the accepted tradeoff for a
 * shared household device. Login itself is still password-gated and rate limited.
 */
export async function GET() {
  if (!(await isMultiUserEnabled())) return apiError('Not found', 404);

  const users = await prisma.user.findMany({
    orderBy: [{ isAdmin: 'desc' }, { username: 'asc' }],
    select: { id: true, username: true, displayName: true, avatar: true, passwordHash: true },
  });
  // passwordHash is read only to derive hasPassword -- it never leaves the server.
  const profiles = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    hasPassword: u.passwordHash !== null,
  }));
  return apiSuccess({ profiles });
}
