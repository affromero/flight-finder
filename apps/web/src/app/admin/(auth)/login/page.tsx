import { redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { LoginForm } from './LoginForm';

// Force dynamic — isMultiUserEnabled depends on the DB. Without this,
// the page is prerendered at build time with multi user = false (no DB
// at build), the redirect branch is skipped, and the legacy admin form
// stays cached even after a self hoster enables multi user mode.
export const dynamic = 'force-dynamic';

export default async function AdminLoginPage() {
  // In multi user mode the unified /login handles every account. Forward
  // bookmarks and old links there so admins don't see two different forms.
  if (await isMultiUserEnabled()) {
    redirect('/login?next=/admin');
  }
  return <LoginForm />;
}
