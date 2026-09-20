import { AccessScreen } from './AccessScreen';
import { InvitationScreen } from './InvitationScreen';
import { sanitizeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string }> }) {
  const params = await searchParams;
  const next = sanitizeNext(params.next);
  if (params.mode === 'invite') return <InvitationScreen next={next ?? '/'} />;
  const mode = params.mode === 'claim' || params.mode === 'recover' || params.mode === 'household' ? params.mode : 'login';
  return <AccessScreen next={next} mode={mode} />;
}
