import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { hashPassword, verifyHashedPassword } from '@/lib/password';
import {
  incrementAuthFailure,
  getAuthFailureCount,
  getRetryAfterSeconds,
  clearAuthFailures,
} from '@/lib/rate-limit';

const MIN_PASSWORD_LENGTH = 8;
const MAX_ATTEMPTS = 5;

/**
 * Self-service password change for the signed-in user. Always scoped to the
 * session (getCurrentUser); a userId in the body is ignored, so one user can
 * never change another's password. The current password must be verified
 * first, and wrong-current-password attempts are throttled by user id to stop
 * a hijacked session from brute forcing the old password.
 */
export async function POST(request: NextRequest) {
  if (!(await isMultiUserEnabled())) return apiError('Not found', 404);
  const user = await getCurrentUser();
  if (!user) return apiError('Unauthorized', 401);

  const rlKey = `pw-change:${user.id}`;
  if ((await getAuthFailureCount(rlKey)) >= MAX_ATTEMPTS) {
    const retry = await getRetryAfterSeconds(rlKey);
    return apiError(`Too many attempts. Try again in ${retry || 900} seconds.`, 429);
  }

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return apiError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  // A passwordless member has no current password to verify -- this is them
  // setting one for the first time. Everyone else must present the current one.
  if (user.passwordHash !== null) {
    const valid = await verifyHashedPassword(currentPassword, user.passwordHash);
    if (!valid) {
      await incrementAuthFailure(rlKey);
      return apiError('Current password is incorrect', 403);
    }
  }

  const passwordHash = await hashPassword(newPassword);
  // sessionsValidFrom revokes every existing session (this device included);
  // the client redirects to login. Closes the window where a stolen pre-change
  // cookie keeps working.
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, sessionsValidFrom: new Date() },
  });
  await clearAuthFailures(rlKey);

  return apiSuccess({ changed: true });
}
