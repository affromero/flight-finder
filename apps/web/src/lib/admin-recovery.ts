import { PrincipalManagement } from 'thesidedoor-core/access';
import { invalidateMultiUserCache } from '@/lib/multi-user';
import { sharedAccess, sharedAccessStore } from '@/lib/sidedoor/access/service';

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: string };

/** Local operator recovery rotates the one shared password and revokes active access. */
export async function resetSharedPassword(newPassword: string): Promise<ResetPasswordResult> {
  if (newPassword.length < 12 || Buffer.byteLength(newPassword) > 1024)
    return { ok: false, error: 'Password must contain at least 12 characters and at most 1024 bytes' };
  const owner = (await sharedAccess.store.read()).principals.find(principal => principal.role === 'owner');
  if (!owner) return { ok: false, error: 'The first Admin profile has not been claimed' };
  await new PrincipalManagement(sharedAccess).resetPasswordForOperator(owner.id, newPassword);
  return { ok: true };
}

/** Disable household profiles atomically while preserving owner credentials, setup and content. */
export async function disableMultiUserMode(ownerToken?: string): Promise<void> {
  await sharedAccessStore.disableProfiles(ownerToken);
  await invalidateMultiUserCache();
}
