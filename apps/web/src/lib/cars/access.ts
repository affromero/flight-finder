import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentProfile, getCurrentUser } from '@/lib/user-auth';
import { CarError } from './types';

export interface CarActor { userId: string | null; isAdmin: boolean }

export async function carActor(): Promise<CarActor> {
  if (process.env.SELF_HOSTED !== 'true') throw new CarError('Car tracking is available on self-hosted instances', 404);
  if (!(await isMultiUserEnabled())) {
    const owner = await getCurrentUser();
    if (!owner) throw new CarError('Sign in to use car tracking', 401);
    if (!owner.isAdmin) throw new CarError('Owner access required', 403);
    return { userId: null, isAdmin: true };
  }
  const user = await getCurrentProfile();
  if (!user) throw new CarError('Sign in to use car tracking', 401);
  return { userId: user.id, isAdmin: user.isAdmin };
}

export function assertCarOwner<T extends { userId: string | null }>(actor: CarActor, row: T | null): asserts row is T {
  if (!row || (!actor.isAdmin && row.userId !== actor.userId)) throw new CarError('Car tracker or search not found', 404);
}
