import { resetSharedPassword, disableMultiUserMode } from '@/lib/admin-recovery';
import { prisma } from '@/lib/prisma';

// Headless recovery entry points invoked from index.tsx for the self-hosted
// `flight-finder reset-password` / `flight-finder disable-multi-user` commands.
// They run inside the `web` container, talk straight to the DB, and exit.
// Never render ink or open a browser. Mirrors lib/json-output.ts.

/**
 * Rotate the shared gate password and exit after a local operator recovery.
 */
export async function runResetPassword(newPassword: string): Promise<void> {
  let exitCode = 0;
  try {
    const result = await resetSharedPassword(newPassword);
    if (result.ok) {
      console.log('Shared password updated. Previous sessions and household passkeys were revoked.');
      console.log('Enter the new password, then choose the Admin profile.');
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
 * Turn off per-profile tracker separation while retaining the shared gate.
 */
export async function runDisableMultiUser(): Promise<void> {
  let exitCode = 0;
  try {
    await disableMultiUserMode();
    console.log('Multi user mode disabled. Your trackers are preserved.');
    console.log('The shared password, passkeys, and profiles remain available.');
    console.log('Turn multi user mode back on from Settings.');
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(exitCode);
}
