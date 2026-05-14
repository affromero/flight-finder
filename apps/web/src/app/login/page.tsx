import { notFound, redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { LoginForm } from './LoginForm';

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  // Multi user mode is the only context where this page makes sense. In any
  // other deployment, pretend it doesn't exist to avoid leaking the feature.
  if (!(await isMultiUserEnabled())) notFound();

  const { next } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  const user = await getCurrentUser();
  if (user) redirect(safeNext ?? (user.isAdmin ? '/admin' : '/account'));

  return <LoginForm next={safeNext} />;
}
