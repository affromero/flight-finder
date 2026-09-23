import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/user-auth';
import { currentAccessSession } from '@/lib/sidedoor/access/session';
import { sanitizeNext } from '@/lib/safe-next';
import { LoginForm } from './LoginForm';

// Force dynamic rendering — isMultiUserEnabled and getCurrentUser depend on
// the DB and the request cookie. Without this, Next.js prerenders the page
// at build time (when neither is reachable), bakes the notFound() result
// into a static 404, and serves that forever in production.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  const safeNext = sanitizeNext(next);
  if (!(await currentAccessSession())) redirect(`/access?next=${encodeURIComponent('/login')}`);

  const user = await getCurrentUser();
  if (user) redirect(safeNext ?? (user.isAdmin ? '/admin' : '/account'));

  return <LoginForm next={safeNext} />;
}
