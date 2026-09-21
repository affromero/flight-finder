import { cookies } from 'next/headers';
import type { User } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { currentAccessSession } from '@/lib/sidedoor/access/session';
import { sharedProfiles, SHARED_SESSION_COOKIE } from '@/lib/sidedoor/access/service';
import { isAccessError } from 'thesidedoor-core/access';

/** Authenticated identity only. Selecting a household profile never satisfies this check. */
export async function getCurrentUser(): Promise<User | null> {
  const auth = await currentAccessSession();
  if (!auth?.principal) return null;
  const user = await prisma.user.findUnique({ where: { id: auth.principal.id } });
  return user ? { ...user, isAdmin: auth.principal.role === 'owner' } : null;
}

/** Content preferences and ownership within an admitted household. */
export async function getCurrentProfile(): Promise<User | null> {
  const auth = await currentAccessSession();
  if (!auth) return null;
  if (auth.principal) {
    const user = await prisma.user.findUnique({ where: { id: auth.principal.id } });
    return user ? { ...user, isAdmin: auth.principal.role === 'owner' } : null;
  }
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const profile = await sharedProfiles.selected(token);
    if (!profile) return null;
    const user = await prisma.user.findUnique({ where: { id: profile.id } });
    if (!user || user.isAdmin) return null;
    return { ...user, isAdmin: false };
  } catch (error) {
    if (isAccessError(error) && error.code === 'unauthorized') return null;
    throw error;
  }
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
