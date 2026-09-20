import { cookies } from 'next/headers';
import { isAccessError, type AuthenticatedSession } from 'thesidedoor-core/access';
import { sharedAccess, SHARED_SESSION_COOKIE } from './service';

export async function currentAccessSession(): Promise<AuthenticatedSession | null> {
  const token = (await cookies()).get(SHARED_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await sharedAccess.authenticate(token);
  } catch (error) {
    if (isAccessError(error) && error.code === 'unauthorized') return null;
    throw error;
  }
}
