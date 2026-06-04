import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import { invalidateMultiUserCache } from '@/lib/multi-user';

// Break-glass recovery used by the self-hosted CLI (`flight-finder reset-password`
// / `flight-finder disable-accounts`) when an admin is locked out of multi user
// mode. There is no in-app UI for these: the only password reset is the admin
// Users page, which itself needs an admin session, the very thing a locked out
// admin lacks. These run inside the `web` container against the same DB/Redis.

// Mirrors the per-route convention (multi-user/route.ts, admin/users/[id]/route.ts):
// each handler declares its own minimum rather than sharing a constant.
const MIN_PASSWORD_LENGTH = 8;

export type ResetPasswordResult =
  | { ok: true; isAdmin: boolean }
  | { ok: false; error: string };

/**
 * Set a new password for the user with the given username. username is @unique,
 * so the lookup is unambiguous. Returns ok:false (rather than throwing) for the
 * two expected operator errors so the CLI can print a clean message.
 */
export async function resetUserPassword(
  username: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, isAdmin: true },
  });
  if (!user) {
    return { ok: false, error: `User "${username}" not found` };
  }

  const passwordHash = await hashPassword(newPassword);
  // Update by the id we just selected, not the username, so a concurrent rename
  // can't redirect the write to a different row. sessionsValidFrom revokes the
  // user's existing sessions so a break-glass reset also locks out old cookies.
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, sessionsValidFrom: new Date() },
  });

  return { ok: true, isAdmin: user.isAdmin };
}

/**
 * Turn multi user mode off and clear the dormant legacy solo-admin hash, leaving
 * a self-hosted instance with no stored credential. In SELF_HOSTED mode the
 * middleware skips admin auth entirely, so afterward the app requires no login.
 *
 * upsert (not updateMany) so the end state is guaranteed: a break-glass command
 * must not print success while changing nothing if the singleton row is somehow
 * absent. If it exists (the normal case), only these two fields change and every
 * other setting is left intact.
 *
 * Cache invalidation is correct because this runs inside the `web` container,
 * sharing REDIS_URL and the `ft:multi-user` key; the 60s TTL would self-heal a
 * missed bust anyway.
 */
export async function disableMultiUserMode(): Promise<void> {
  await prisma.extractionConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', multiUserMode: false, adminPasswordHash: null },
    update: { multiUserMode: false, adminPasswordHash: null },
  });
  await invalidateMultiUserCache();
}
