import { redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { verifyAdminSessionRevocable } from '@/lib/admin-guard';
import { DashboardNav } from './DashboardNav';

// Force dynamic — the multi user gate (isMultiUserEnabled + getCurrentUser)
// must run per request. Without this, layouts for /admin/* pages (e.g.
// /admin/config) prerender at build time with multi user = false and the
// redirect branch is skipped, leaving the layout uncached for the multi
// user case.
export const dynamic = 'force-dynamic';

const isSelfHosted = process.env.SELF_HOSTED === 'true';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const multiUserEnabled = await isMultiUserEnabled();

  let currentUser: { username: string; displayName: string | null; avatar: string | null } | null =
    null;

  // In multi user mode, every admin page requires a logged-in admin user.
  if (multiUserEnabled) {
    const user = await getCurrentUser();
    if (!user) redirect('/login?next=/admin');
    if (!user.isAdmin) redirect('/account');
    currentUser = { username: user.username, displayName: user.displayName, avatar: user.avatar };
  } else if (!isSelfHosted) {
    // Hosted / legacy admin (non multi user): the Edge middleware already
    // verified the admin cookie's HMAC + 7-day expiry, but it cannot reach the
    // DB to honor adminSessionsValidFrom. Perform the authoritative revocation
    // check here so an admin cookie issued before the last password change is
    // bounced to login, mirroring how the multi user branch above uses
    // getCurrentUser. Solo self-hosted has no admin cookie (middleware bypasses
    // admin auth), so this check only runs in hosted mode.
    if (!(await verifyAdminSessionRevocable())) redirect('/admin/login');
  }

  return (
    <DashboardNav isSelfHosted={isSelfHosted} multiUserEnabled={multiUserEnabled} user={currentUser}>
      {children}
    </DashboardNav>
  );
}
