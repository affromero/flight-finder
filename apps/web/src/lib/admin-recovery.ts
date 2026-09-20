import { prisma } from '@/lib/prisma';
import { PrincipalManagement } from 'thesidedoor-core/access';
import { invalidateMultiUserCache } from '@/lib/multi-user';
import { sharedAccess, sharedAccessStore } from '@/lib/sidedoor/access/service';

export type ResetPasswordResult =
  | { ok: true; isAdmin: boolean }
  | { ok: false; error: string };

/** Local operator recovery keeps existing identity and revokes its active access. */
export async function resetUserPassword(username: string, newPassword: string): Promise<ResetPasswordResult> {
  if (newPassword.length < 12 || Buffer.byteLength(newPassword) > 1024)
    return { ok: false, error: 'Password must contain at least 12 characters and at most 1024 bytes' };
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) return { ok: false, error: `User "${username}" not found` };
  const role = await new PrincipalManagement(sharedAccess).resetPasswordForOperator(user.id, newPassword);
  return { ok: true, isAdmin: role === 'owner' };
}

/** Disable household profiles atomically while preserving owner credentials, setup and content. */
export async function disableMultiUserMode(ownerToken?: string): Promise<void> {
  await sharedAccessStore.disableProfiles(ownerToken);
  await invalidateMultiUserCache();
}
