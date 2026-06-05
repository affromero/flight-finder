'use client';

import { useRouter } from 'next/navigation';
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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SeedRouteRow({ seed }: { seed: SeedData }) {
  const router = useRouter();
  const hydrated = useHydrated();

  const handleToggle = async () => {
    await fetch(`/api/admin/seed-routes/${seed.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !seed.active }),
    });
    router.refresh();
  };

  const handleDelete = async () => {
    if (!confirm(`Delete seed route ${seed.origin} → ${seed.destination}?`)) return;
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
        <span className={styles.seedBadge}>SEED</span>
        {!seed.active && <span className={styles.pausedBadge}>PAUSED</span>}
      </div>
      <div className={styles.rowMeta}>
        <span>{seed.originName} → {seed.destinationName}</span>
        <span className={styles.rowSep}>·</span>
        <span>{seed.cabinClass}</span>
        <span className={styles.rowSep}>·</span>
        <span>{seed.snapshotCount} snapshots</span>
        <span className={styles.rowSep}>·</span>
        <span>{seed.runCount} runs</span>
        {seed.lastRunAt && (
          <>
            <span className={styles.rowSep}>·</span>
            <span>last: {hydrated ? timeAgo(seed.lastRunAt) : '…'} ({seed.lastRunStatus})</span>
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
          <span>Tracking: {seed.preferredAirlines.join(', ')}</span>
        </div>
      )}
      <div className={styles.rowActions}>
        <select className={styles.intervalSelect} value={seed.scrapeInterval ?? ''} onChange={handleIntervalChange}>
          <option value="">Follow global</option>
          <option value={1}>Every 1h</option>
          <option value={3}>Every 3h</option>
          <option value={6}>Every 6h</option>
          <option value={12}>Every 12h</option>
          <option value={24}>Every 24h</option>
        </select>
        <select className={styles.intervalSelect} value={seed.lookAheadDays} onChange={handleLookAheadChange}>
          <option value={7}>7d ahead</option>
          <option value={14}>14d ahead</option>
          <option value={21}>21d ahead</option>
          <option value={30}>30d ahead</option>
        </select>
        <button
          className={seed.active ? styles.pauseButton : styles.resumeButton}
          onClick={handleToggle}
        >
          {seed.active ? 'Pause' : 'Resume'}
        </button>
        <button className={styles.deleteButton} onClick={handleDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
