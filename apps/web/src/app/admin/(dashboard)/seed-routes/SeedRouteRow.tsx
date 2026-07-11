'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useHydrated } from '@/lib/use-hydrated';
import styles from './page.module.css';

interface SeedData {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  active: boolean;
  lookAheadDays: number;
  scrapeInterval: number | null;
  cabinClass: string;
  preferredAirlines: string[];
  snapshotCount: number;
  runCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  airlinesSeen: string[];
  createdAt: string;
}

export function SeedRouteRow({ seed }: { seed: SeedData }) {
  const t = useTranslations('AdminSeedRoutes');
  const router = useRouter();
  const hydrated = useHydrated();

  const timeAgo = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 1) return t('row.justNow');
    if (hours < 24) return t('row.hoursAgo', { hours });
    return t('row.daysAgo', { days: Math.floor(hours / 24) });
  };

  const handleToggle = async () => {
    await fetch(`/api/admin/seed-routes/${seed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !seed.active }),
    });
    router.refresh();
  };

  const handleDelete = async () => {
    if (!confirm(t('row.deleteConfirm', { origin: seed.origin, destination: seed.destination }))) return;
    await fetch(`/api/admin/seed-routes/${seed.id}`, { method: 'DELETE' });
    router.refresh();
  };

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value === '' ? null : Number(e.target.value);
    await fetch(`/api/admin/seed-routes/${seed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scrapeInterval: value }),
    });
    router.refresh();
  };

  const handleLookAheadChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    await fetch(`/api/admin/seed-routes/${seed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookAheadDays: Number(e.target.value) }),
    });
    router.refresh();
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowRoute}>
        <span className={styles.rowCode}>{seed.origin}</span>
        <span className={styles.rowArrow}>→</span>
        <span className={styles.rowCode}>{seed.destination}</span>
        <span className={styles.seedBadge}>{t('row.seedBadge')}</span>
        {!seed.active && <span className={styles.pausedBadge}>{t('row.pausedBadge')}</span>}
      </div>
      <div className={styles.rowMeta}>
        <span>{seed.originName} → {seed.destinationName}</span>
        <span className={styles.rowSep}>·</span>
        <span>{seed.cabinClass}</span>
        <span className={styles.rowSep}>·</span>
        <span>{t('row.snapshots', { count: seed.snapshotCount })}</span>
        <span className={styles.rowSep}>·</span>
        <span>{t('row.runs', { count: seed.runCount })}</span>
        {seed.lastRunAt && (
          <>
            <span className={styles.rowSep}>·</span>
            <span>{t('row.lastRun', { time: hydrated ? timeAgo(seed.lastRunAt) : '…', status: seed.lastRunStatus ?? '' })}</span>
          </>
        )}
      </div>
      {seed.airlinesSeen.length > 0 && (
        <div className={styles.airlines}>
          {seed.airlinesSeen.map((a) => (
            <span key={a} className={styles.airlineTag}>{a}</span>
          ))}
        </div>
      )}
      {seed.preferredAirlines.length > 0 && (
        <div className={styles.rowMeta}>
          <span>{t('row.tracking', { airlines: seed.preferredAirlines.join(', ') })}</span>
        </div>
      )}
      <div className={styles.rowActions}>
        <select className={styles.intervalSelect} value={seed.scrapeInterval ?? ''} onChange={handleIntervalChange}>
          <option value="">{t('row.followGlobal')}</option>
          <option value={1}>{t('row.everyHours', { hours: 1 })}</option>
          <option value={3}>{t('row.everyHours', { hours: 3 })}</option>
          <option value={6}>{t('row.everyHours', { hours: 6 })}</option>
          <option value={12}>{t('row.everyHours', { hours: 12 })}</option>
          <option value={24}>{t('row.everyHours', { hours: 24 })}</option>
        </select>
        <select className={styles.intervalSelect} value={seed.lookAheadDays} onChange={handleLookAheadChange}>
          <option value={7}>{t('row.daysAhead', { days: 7 })}</option>
          <option value={14}>{t('row.daysAhead', { days: 14 })}</option>
          <option value={21}>{t('row.daysAhead', { days: 21 })}</option>
          <option value={30}>{t('row.daysAhead', { days: 30 })}</option>
        </select>
        <button
          className={seed.active ? styles.pauseButton : styles.resumeButton}
          onClick={handleToggle}
        >
          {seed.active ? t('row.pause') : t('row.resume')}
        </button>
        <button className={styles.deleteButton} onClick={handleDelete}>
          {t('row.delete')}
        </button>
      </div>
    </div>
  );
}
