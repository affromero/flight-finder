import { resetUserPassword, disableMultiUserMode } from '@/lib/admin-recovery';
import { prisma } from '@/lib/prisma';

// Headless recovery entry points invoked from index.tsx for the self-hosted
// `flight-finder reset-password` / `flight-finder disable-accounts` commands.
// They run inside the `web` container, talk straight to the DB, and exit.
// Never render ink or open a browser. Mirrors lib/json-output.ts.

/**
 * Set a known password for a user and exit. Recovers a locked out multi user
 * mode admin who forgot their password.
 */
export async function runResetPassword(username: string, newPassword: string): Promise<void> {
  let exitCode = 0;
  try {
    const result = await resetUserPassword(username, newPassword);
    if (result.ok) {
      console.log(`Password updated for "${username}".`);
      if (result.isAdmin) {
        console.log('Log in with it, then manage other accounts from the admin Users page.');
      }
    } else {
      console.error(`Error: ${result.error}`);
      exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(exitCode);
}

/**
 * Turn multi user mode off and exit. Restores solo self hosted operation where
 * no login is required, and clears the stored admin credential.
 */
export async function runDisableAccounts(): Promise<void> {
  let exitCode = 0;
  try {
    await disableMultiUserMode();
    console.log('Multi user mode disabled. Your trackers are preserved.');
    console.log('This self hosted instance no longer requires any login or password.');
    console.log('Turn accounts back on any time from Settings.');
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(exitCode);
}
