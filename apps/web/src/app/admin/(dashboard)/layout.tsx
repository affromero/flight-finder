import { redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { DashboardNav } from './DashboardNav';

export const dynamic = 'force-dynamic';
const isSelfHosted = process.env.SELF_HOSTED === 'true';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/access?next=/admin');
  if (!user.isAdmin) redirect('/account');
  const multiUserEnabled = await isMultiUserEnabled();
  const currentUser = { username: user.username, displayName: user.displayName, avatar: user.avatar };
  return <DashboardNav isSelfHosted={isSelfHosted} multiUserEnabled={multiUserEnabled} user={currentUser}>{children}</DashboardNav>;
}
