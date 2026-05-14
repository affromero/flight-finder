import { redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { LoginForm } from './LoginForm';

export default async function AdminLoginPage() {
  // In multi user mode the unified /login handles every account. Forward
  // bookmarks and old links there so admins don't see two different forms.
  if (await isMultiUserEnabled()) {
    redirect('/login?next=/admin');
  }
  return <LoginForm />;
}
