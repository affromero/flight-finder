import { notFound, redirect } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { HotelDetail } from '@/components/hotels/HotelDetail';
import { TravelNav } from '@/components/hotels/TravelNav';
import styles from '@/components/hotels/Hotels.module.css';
export const dynamic = 'force-dynamic';
export default async function HotelPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.SELF_HOSTED !== 'true') notFound();
  const { id } = await params;
  const multiUser = await isMultiUserEnabled();
  const user = multiUser ? await getCurrentUser() : null;
  if (multiUser && !user) redirect(`/login?next=${encodeURIComponent(`/hotels/${id}`)}`);
  return <main className={styles.root}><TravelNav active="hotels" /><HotelDetail id={id} canReassign={Boolean(user?.isAdmin)} /></main>;
}
