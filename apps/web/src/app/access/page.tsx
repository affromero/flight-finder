import { AccessScreen } from './AccessScreen';
import { InvitationScreen } from './InvitationScreen';
import { sanitizeNext } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string }> }) {
  const params = await searchParams;
  const next = sanitizeNext(params.next);
  if (params.mode === 'invite') return <InvitationScreen next={next ?? '/'} />;
  const hosted = process.env.SELF_HOSTED !== 'true';
  const mode = params.mode === 'recover' || (!hosted && params.mode === 'claim')
    ? params.mode
    : hosted ? 'login' : 'household';
  return <AccessScreen next={next} mode={mode} hosted={hosted} />;
}
