'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSavedTrackers, getDeleteToken, removeSavedTracker } from '@/lib/tracker-storage';
import styles from './SavedTrackers.module.css';

interface ActiveQuery {
  id: string;
  active: boolean;
  origin: string;
  destination: string;
  originName: string;
  destinationName: string;
  dateFrom: string;
  dateTo: string;
  scrapeInterval: number;
  snapshotCount: number;
  lastScrapedAt: string | null;
  groupId: string | null;
  createdAt: string;
}

interface DisplayTracker {
  id: string;
  origin: string;
  destination: string;
  dateFrom: string;
  dateTo: string;
  snapshotCount: number;
  lastScrapedAt: string | null;
  status: 'active' | 'paused' | 'expired' | 'deleted';
  hasDeleteToken: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SavedTrackers({ isAuthenticated = false }: { isAuthenticated?: boolean } = {}) {
  const [trackers, setTrackers] = useState<DisplayTracker[]>([]);

  useEffect(() => {
    // In multi user mode the server response is authoritative for the current
    // user — localStorage fallback only made sense in the deleteToken era.
    const localTrackers = isAuthenticated ? [] : getSavedTrackers();
    const deleteTokenMap = new Map(
      localTrackers.filter((t) => t.deleteToken).map((t) => [t.id, t.deleteToken!])
    );

    // Fetch all active queries from server
    fetch('/api/queries/active')
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok || !data.data?.queries) {
          if (isAuthenticated) {
            setTrackers([]);
            return;
          }
          fallbackToLocal(localTrackers);
          return;
        }

        const serverQueries: ActiveQuery[] = data.data.queries;

        if (serverQueries.length > 0 || isAuthenticated) {
          // Server response is authoritative when logged in. Solo/anonymous
          // still gets the localStorage merge for backward compat.
          const display: DisplayTracker[] = serverQueries.map((q) => ({
            id: q.id,
            origin: q.origin,
            destination: q.destination,
            dateFrom: q.dateFrom,
            dateTo: q.dateTo,
            snapshotCount: q.snapshotCount,
            lastScrapedAt: q.lastScrapedAt,
            status: q.active ? 'active' : 'paused',
            hasDeleteToken: deleteTokenMap.has(q.id),
          }));
          setTrackers(display);
        } else {
          // No server queries — fall back to localStorage
          fallbackToLocal(localTrackers);
        }
      })
      .catch(() => {
        if (isAuthenticated) setTrackers([]);
        else fallbackToLocal(localTrackers);
      });

    function fallbackToLocal(saved: typeof localTrackers) {
      if (saved.length === 0) return;
      fetch('/api/queries/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: saved.map((t) => t.id) }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (!data.ok) return;
          const statusMap = data.data as Record<string, 'active' | 'expired' | 'deleted'>;
          setTrackers(
            saved.map((t) => ({
              id: t.id,
              origin: t.origin,
              destination: t.destination,
              dateFrom: t.dateFrom,
              dateTo: t.dateTo,
              snapshotCount: 0,
              lastScrapedAt: null,
              status: statusMap[t.id] ?? 'deleted',
              hasDeleteToken: Boolean(t.deleteToken),
            }))
          );
        })
        .catch(() => {
          setTrackers(
            saved.map((t) => ({
              ...t,
              snapshotCount: 0,
              lastScrapedAt: null,
              status: 'active' as const,
              hasDeleteToken: Boolean(t.deleteToken),
            }))
          );
        });
    }
  }, [isAuthenticated]);

  const handleRemove = async (id: string) => {
    const token = getDeleteToken(id);
    try {
      const res = await fetch(`/api/queries/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: token }),
      });
      const data = await res.json();
      if (!data.ok) {
        // API rejected -- still remove from local view
        console.warn(`Delete API returned: ${data.error}`);
      }
    } catch {
      // Network error -- still remove from local view
    }
    removeSavedTracker(id);
    setTrackers((prev) => prev.filter((t) => t.id !== id));
  };

  const handleTogglePause = async (id: string, currentlyActive: boolean) => {
    const res = await fetch(`/api/admin/queries/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !currentlyActive }),
    });
    const data = await res.json();
    if (data.ok) {
      setTrackers((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: currentlyActive ? 'paused' : 'active' } : t
        )
      );
    }
  };

  if (trackers.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <p className={styles.emptyText}>
            No trackers yet. Search for a flight above to start tracking prices.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <h3 className={styles.title}>Your Trackers</h3>
      <div className={styles.list}>
        {trackers.map((t) => (
          <div key={t.id} className={styles.card}>
            <button
              className={styles.remove}
              onClick={() => handleRemove(t.id)}
              title="Remove"
              aria-label="Remove tracker"
            >
              &times;
            </button>

            {t.status === 'deleted' ? (
              <div className={styles.content}>
                <div className={styles.route}>
                  <span className={styles.code}>{t.origin}</span>
                  <span className={styles.arrow}>&rarr;</span>
                  <span className={styles.code}>{t.destination}</span>
                </div>
                <span className={`${styles.badge} ${styles.badgeDeleted}`}>Unavailable</span>
              </div>
            ) : (
              <Link href={`/q/${t.id}`} className={styles.link}>
                <div className={styles.content}>
                  <div className={styles.route}>
                    <span className={styles.code}>{t.origin}</span>
                    <span className={styles.arrow}>&rarr;</span>
                    <span className={styles.code}>{t.destination}</span>
                  </div>
                  <span className={styles.dates}>
                    {formatDate(t.dateFrom)} &mdash; {formatDate(t.dateTo)}
                  </span>
                  <div className={styles.meta}>
                    {t.snapshotCount > 0 && (
                      <span className={styles.snapshots}>
                        {t.snapshotCount} price{t.snapshotCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {t.lastScrapedAt && (
                      <span className={styles.lastScrape}>
                        {timeAgo(t.lastScrapedAt)}
                      </span>
                    )}
                  </div>
                  <div className={styles.cardActions}>
                    <span className={`${styles.badge} ${
                      t.status === 'active' ? styles.badgeActive
                        : t.status === 'paused' ? styles.badgePaused
                        : styles.badgeExpired
                    }`}>
                      {t.status === 'active' ? 'Tracking' : t.status === 'paused' ? 'Paused' : 'Expired'}
                    </span>
                    {(t.status === 'active' || t.status === 'paused') && (
                      <button
                        className={styles.pauseBtn}
                        onClick={(e) => {
                          e.preventDefault();
                          handleTogglePause(t.id, t.status === 'active');
                        }}
                        title={t.status === 'active' ? 'Pause tracking' : 'Resume tracking'}
                      >
                        {t.status === 'active' ? '⏸' : '▶'}
                      </button>
                    )}
                  </div>
                </div>
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
