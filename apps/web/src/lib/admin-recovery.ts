import { invalidateMultiUserCache } from '@/lib/multi-user';
import { sharedAccessStore } from '@/lib/sidedoor/access/service';

/** Disable household profiles atomically while preserving owner credentials, setup and content. */
export async function disableMultiUserMode(ownerToken?: string): Promise<void> {
  await sharedAccessStore.disableProfiles(ownerToken);
  await invalidateMultiUserCache();
}
