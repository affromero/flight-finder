'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import styles from './Hotels.module.css';
export function TravelNav({ active }: { active: 'flights' | 'hotels' }) {
  const t = useTranslations('Hotels');
  return <nav className={styles.nav} aria-label={t('travel')}><Link href="/" aria-current={active === 'flights' ? 'page' : undefined}>{t('flights')}</Link><Link href="/hotels" aria-current={active === 'hotels' ? 'page' : undefined}>{t('hotels')}</Link></nav>;
}
