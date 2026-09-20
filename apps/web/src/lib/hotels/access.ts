import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentProfile, getCurrentUser } from '@/lib/user-auth';
import { HotelError } from './domain';

export interface HotelActor { userId: string | null; isAdmin: boolean }
export async function hotelActor(): Promise<HotelActor> {
  if (process.env.SELF_HOSTED !== 'true') throw new HotelError('Hotel tracking is available on self-hosted instances', 404);
  if (!(await isMultiUserEnabled())) {
    const owner = await getCurrentUser();
    if (!owner) throw new HotelError('Sign in to use hotel tracking', 401);
    if (!owner.isAdmin) throw new HotelError('Owner access required', 403);
    return { userId: null, isAdmin: true };
  }
  const user = await getCurrentProfile();
  if (!user) throw new HotelError('Sign in to use hotel tracking', 401);
  return { userId: user.id, isAdmin: user.isAdmin };
}
export function assertHotelOwner(actor: HotelActor, row: { userId: string | null } | null): asserts row is { userId: string | null } {
  if (!row || (!actor.isAdmin && row.userId !== actor.userId)) throw new HotelError('Hotel tracker or search not found', 404);
}
