import { redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { DashboardNav } from './DashboardNav';

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
