import { redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
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

  // In multi user mode, every admin page requires a logged-in admin user.
  // Solo mode (and hosted) keep the original gating via middleware.
  if (multiUserEnabled) {
    const user = await getCurrentUser();
    if (!user) redirect('/login?next=/admin');
    if (!user.isAdmin) redirect('/account');
  }

  return (
    <DashboardNav isSelfHosted={isSelfHosted} multiUserEnabled={multiUserEnabled}>
      {children}
    </DashboardNav>
  );
}
