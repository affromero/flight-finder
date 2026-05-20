'use client';

import { useRouter } from 'next/navigation';
import { type QueryGroup, type GroupableQuery } from '@/lib/query-grouping';
import styles from './page.module.css';

export interface AdminQuery extends GroupableQuery {
  active: boolean;
  expiresAt: string;
  scrapeInterval: number | null;
  snapshotCount: number;
  runCount: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function QueryGroupRow({ group }: { group: QueryGroup<AdminQuery> }) {
  const router = useRouter();
  const expired = group.allExpired;
  const runCount = group.queries.reduce((sum, q) => sum + q.runCount, 0);
  const extraDestinations = group.destinations.length - 1;

  const handleToggle = async () => {
    await fetch(`/api/queries/${group.primaryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !group.anyActive }),
    });
    router.refresh();
  };

  const handleDelete = async () => {
    const label = `${group.origin} → ${group.destination}`;
    const suffix = group.routeCount > 1 ? ` (${group.routeCount} charts)?` : '?';
    if (!confirm(`Delete tracker for ${label}${suffix}`)) return;
    await fetch(`/api/queries/${group.primaryId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupDelete: group.routeCount > 1 }),
    });
    router.refresh();
  };

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value === '' ? null : Number(e.target.value);
    await fetch(`/api/queries/${group.primaryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scrapeInterval: value }),
    });
    router.refresh();
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowRoute}>
        <span className={styles.rowCode}>{group.origin}</span>
        <span className={styles.rowArrow}>→</span>
        <span className={styles.rowCode}>{group.destination}</span>
        {extraDestinations > 0 && (
          <span className={styles.rowGroupTag}>+ {extraDestinations} more</span>
        )}
        {group.routeCount > 1 && (
          <span className={styles.rowGroupTag}>{group.routeCount} charts</span>
        )}
      </div>
      <div className={styles.rowMeta}>
        <span>{formatDate(group.dateFrom)} — {formatDate(group.dateTo)}</span>
        <span className={styles.rowSep}>·</span>
        <span>{group.snapshotCount} snapshots</span>
        <span className={styles.rowSep}>·</span>
        <span>{runCount} runs</span>
      </div>
      <div className={styles.rowActions}>
        <select
          className={styles.intervalSelect}
          value={group.scrapeInterval ?? ''}
          onChange={handleIntervalChange}
        >
          <option value="">Follow global</option>
          <option value={1}>Every 1h</option>
          <option value={3}>Every 3h</option>
          <option value={6}>Every 6h</option>
          <option value={12}>Every 12h</option>
          <option value={24}>Every 24h</option>
        </select>
        <button
          className={group.anyActive ? styles.pauseButton : styles.resumeButton}
          onClick={handleToggle}
          disabled={expired}
        >
          {expired ? 'Expired' : group.anyActive ? 'Pause' : 'Resume'}
        </button>
        <a href={`/q/${group.primaryId}`} className={styles.viewLink} target="_blank" rel="noopener noreferrer">
          View
        </a>
        <button className={styles.deleteButton} onClick={handleDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
