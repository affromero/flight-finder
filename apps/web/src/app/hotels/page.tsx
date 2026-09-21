import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentProfile } from '@/lib/user-auth';
import { HotelSearchExperience } from '@/components/hotels/HotelSearchExperience';
import { HotelTrackers } from '@/components/hotels/HotelTrackers';
import { TravelNav } from '@/components/hotels/TravelNav';
import { ThemeToggle } from '@/components/ThemeToggle';
import styles from '@/components/hotels/Hotels.module.css';
import { getHotelMapConfig } from '@/lib/hotels/map-config-store';
import { DEFAULT_HOTEL_MAP_CONFIG, DEFAULT_HOTEL_MAP_PREFERENCES, validateHotelMapPreferences, type HotelMapSettings } from '@/lib/hotels/map-config';
export const dynamic = 'force-dynamic';
export default async function HotelsPage() {
  if (process.env.SELF_HOSTED !== 'true') notFound();
  const multiUser = await isMultiUserEnabled();
  const user = multiUser ? await getCurrentProfile() : null;
  if (multiUser && !user) redirect('/login?next=/hotels');
  const t = await getTranslations('Hotels');
  let mapSettings: HotelMapSettings;
  try {
    const { config } = await getHotelMapConfig();
    mapSettings = { config, preferences: user?.hotelMapPreferences ? validateHotelMapPreferences(user.hotelMapPreferences) : DEFAULT_HOTEL_MAP_PREFERENCES, preferencesRevision: user?.hotelMapPreferencesRevision ?? 0, account: !!user, actorScope: user ? `user:${user.id}` : 'solo' };
  } catch {
    mapSettings = { config: { ...DEFAULT_HOTEL_MAP_CONFIG, enabled: false }, preferences: DEFAULT_HOTEL_MAP_PREFERENCES, account: !!user, error: t('mapSettingsError') };
  }
  return <main className={styles.root}><ThemeToggle /><TravelNav active="hotels" /><header className={styles.hero}><span className={styles.eyebrow}>Flight Finder</span><h1>{t('headline')}</h1><p className={styles.muted}>{t('intro')}</p></header><HotelSearchExperience key={user?.id ?? 'solo'} mapSettings={mapSettings} /><HotelTrackers /></main>;
}
