'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { hotelMoney, hotelRequest, type HotelTrackerView } from './client';
import styles from './Hotels.module.css';
export function HotelTrackers({ admin = false }: { admin?: boolean }) {
  const t = useTranslations('Hotels'); const locale = useLocale();
  const failed = t('failed');
  const [trackers, setTrackers] = useState<HotelTrackerView[] | null>(null); const [error, setError] = useState('');
  useEffect(() => { let disposed = false; hotelRequest<{ trackers: HotelTrackerView[] }>(`/api/hotels${admin ? '?admin=true' : ''}`).then((data) => { if (!disposed) setTrackers(data.trackers); }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : failed); }); return () => { disposed = true; }; }, [admin, failed]);
  return <section className={styles.section}><h2 className={styles.heading}>{t('saved')}</h2>{error ? <p className={styles.error} role="alert">{error}</p> : trackers === null ? <p role="status">{t('loading')}</p> : !trackers.length ? <p className={styles.muted}>{t('noTrackers')} <Link href="/hotels">{t('search')}</Link></p> : <ul className={styles.list}>{trackers.map((tracker) => <li className={styles.row} key={tracker.id}><Link href={`/hotels/${tracker.id}`}><strong>{tracker.hotelName}</strong><span className={styles.muted}>{tracker.search.checkIn} → {tracker.search.checkOut} · {t(tracker.active ? 'active' : 'paused')}</span>{tracker.lastError && <p className={styles.error}>{tracker.lastError}</p>}</Link><span className={styles.rowPrice}>{tracker.latestPrice === null ? t('noPrice') : hotelMoney(tracker.latestPrice, tracker.currency, locale)}</span></li>)}</ul>}</section>;
}
