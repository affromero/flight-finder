import { cookies } from 'next/headers';
import type { User } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { sharedAccess, sharedProfiles, SHARED_SESSION_COOKIE } from '@/lib/sidedoor/access/service';
import { isAccessError } from 'thesidedoor-core/access';

/** One household admission and its current profile determine application authority. */
export async function getCurrentUser(): Promise<User | null> {
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const state = await sharedAccess.store.read();
    const auth = sharedAccess.sessionFromState(state, token);
    const id = auth.principal?.id ?? sharedProfiles.selectedFromState(state, token)?.id;
    if (!id) return null;
    const user = await prisma.user.findUnique({ where: { id } });
    return user ? { ...user, isAdmin: user.isAdmin && sharedAccess.householdOwnerFromState(state, token) } : null;
  } catch (error) {
    if (isAccessError(error) && error.code === 'unauthorized') return null;
    throw error;
  }
}

/** Content preferences and ownership within an admitted household. */
export async function getCurrentProfile(): Promise<User | null> {
  return getCurrentUser();
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireAdminUser(): Promise<User> {
  const user = await requireUser();
  if (!user.isAdmin) throw new ForbiddenError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() { super('Unauthorized'); this.name = 'UnauthorizedError'; }
}
export class ForbiddenError extends Error {
  constructor() { super('Forbidden'); this.name = 'ForbiddenError'; }
}
