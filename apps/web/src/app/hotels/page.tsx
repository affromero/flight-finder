import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { HotelSearchExperience } from '@/components/hotels/HotelSearchExperience';
import { HotelTrackers } from '@/components/hotels/HotelTrackers';
import { TravelNav } from '@/components/hotels/TravelNav';
import { ThemeToggle } from '@/components/ThemeToggle';
import styles from '@/components/hotels/Hotels.module.css';
export const dynamic = 'force-dynamic';
export default async function HotelsPage() {
  if (process.env.SELF_HOSTED !== 'true') notFound();
  if (await isMultiUserEnabled() && !await getCurrentUser()) redirect('/login?next=/hotels');
  const t = await getTranslations('Hotels');
  return <main className={styles.root}><ThemeToggle /><TravelNav active="hotels" /><header className={styles.hero}><span className={styles.eyebrow}>Flight Finder</span><h1>{t('headline')}</h1><p className={styles.muted}>{t('intro')}</p></header><HotelSearchExperience /><HotelTrackers /></main>;
}
