'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSavedTrackers, getDeleteToken, removeSavedTracker, type SavedTracker } from '@/lib/tracker-storage';
import { groupQueries, type GroupableQuery, type QueryGroup } from '@/lib/query-grouping';
import { aggregateScrapeStatus, type AggregatedScrape } from '@/lib/scrape-status';
import { ScrapeStatusDot } from './ScrapeStatusDot';
import { ForceScrapeButton } from './ForceScrapeButton';
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
  lastScrapeStatus: string | null;
  lastScrapeError: string | null;
  groupId: string | null;
  label: string | null;
  preferredAggregators: string[];
  createdAt: string;
}

interface DisplayQuery extends GroupableQuery {
  status: 'active' | 'paused' | 'expired' | 'deleted';
  hasDeleteToken: boolean;
  scrapeStatus: string | null;
  scrapeError: string | null;
  label?: string | null;
}

interface DisplayGroup {
  group: QueryGroup<DisplayQuery>;
  status: 'active' | 'paused' | 'expired' | 'deleted';
  hasDeleteToken: boolean;
  aggregate: AggregatedScrape;
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

function deriveGroupStatus(group: QueryGroup<DisplayQuery>): DisplayGroup['status'] {
  // If every sibling is "deleted" upstream (only happens in the localStorage
  // fallback path) → group is deleted. Otherwise prefer active over paused
  // over expired so a partly-active group keeps the tracking badge.
  if (group.queries.every((q) => q.status === 'deleted')) return 'deleted';
  if (group.queries.some((q) => q.status === 'active')) return 'active';
  if (group.queries.some((q) => q.status === 'paused')) return 'paused';
  return 'expired';
}

function toDisplayGroups(queries: DisplayQuery[]): DisplayGroup[] {
  return groupQueries(queries).map((group) => ({
    group,
    status: deriveGroupStatus(group),
    hasDeleteToken: group.queries.some((q) => q.hasDeleteToken),
    aggregate: aggregateScrapeStatus(
      group.queries.map((q) => ({
        status: q.scrapeStatus,
        error: q.scrapeError,
        startedAt: q.lastScrapedAt ?? null,
      })),
    ),
  }));
}

export function SavedTrackers({ isAuthenticated = false }: { isAuthenticated?: boolean } = {}) {
  const [groups, setGroups] = useState<DisplayGroup[]>([]);

  useEffect(() => {
    // In multi user mode the server response is authoritative for the current
    // user — localStorage fallback only made sense in the deleteToken era.
    const localTrackers = isAuthenticated ? [] : getSavedTrackers();
    const deleteTokenSet = new Set(
      localTrackers.filter((t) => t.deleteToken).map((t) => t.id)
    );

    // Fetch all active queries from server
    fetch('/api/queries/active')
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok || !data.data?.queries) {
          if (isAuthenticated) {
            setGroups([]);
            return;
          }
          fallbackToLocal(localTrackers);
          return;
        }

        const serverQueries: ActiveQuery[] = data.data.queries;

        if (serverQueries.length > 0 || isAuthenticated) {
          // Server response is authoritative when logged in. Solo/anonymous
          // still gets the localStorage merge for backward compat.
          const display: DisplayQuery[] = serverQueries.map((q) => ({
            id: q.id,
            origin: q.origin,
            destination: q.destination,
            originName: q.originName,
            destinationName: q.destinationName,
            dateFrom: q.dateFrom,
            dateTo: q.dateTo,
            groupId: q.groupId,
            active: q.active,
            createdAt: q.createdAt,
            snapshotCount: q.snapshotCount,
            lastScrapedAt: q.lastScrapedAt,
            label: q.label,
            status: q.active ? 'active' : 'paused',
            hasDeleteToken: deleteTokenSet.has(q.id),
            scrapeStatus: q.lastScrapeStatus,
            scrapeError: q.lastScrapeError,
          }));
          setGroups(toDisplayGroups(display));
        } else {
          // No server queries — fall back to localStorage
          fallbackToLocal(localTrackers);
        }
      })
      .catch(() => {
        if (isAuthenticated) setGroups([]);
        else fallbackToLocal(localTrackers);
      });

    function fallbackToLocal(saved: SavedTracker[]) {
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
          const display: DisplayQuery[] = saved.map((t) => ({
            id: t.id,
            origin: t.origin,
            destination: t.destination,
            originName: t.originName,
            destinationName: t.destinationName,
            dateFrom: t.dateFrom,
            dateTo: t.dateTo,
            groupId: null,
            createdAt: t.createdAt,
            snapshotCount: 0,
            lastScrapedAt: null,
            status: statusMap[t.id] ?? 'deleted',
            hasDeleteToken: Boolean(t.deleteToken),
            scrapeStatus: null,
            scrapeError: null,
          }));
          setGroups(toDisplayGroups(display));
        })
        .catch(() => {
          const display: DisplayQuery[] = saved.map((t) => ({
            id: t.id,
            origin: t.origin,
            destination: t.destination,
            originName: t.originName,
            destinationName: t.destinationName,
            dateFrom: t.dateFrom,
            dateTo: t.dateTo,
            groupId: null,
            createdAt: t.createdAt,
            snapshotCount: 0,
            lastScrapedAt: null,
            status: 'active',
            hasDeleteToken: Boolean(t.deleteToken),
            scrapeStatus: null,
            scrapeError: null,
          }));
          setGroups(toDisplayGroups(display));
        });
    }
  }, [isAuthenticated]);

  const handleRemove = async (entry: DisplayGroup) => {
    const { group } = entry;
    const label = `${group.origin} → ${group.destination}`;
    const suffix = group.routeCount > 1 ? ` (${group.routeCount} charts)` : '';
    if (!confirm(`Delete tracker for ${label}${suffix}?`)) return;

    const token = getDeleteToken(group.primaryId);
    try {
      const res = await fetch(`/api/queries/${group.primaryId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: token, groupDelete: group.routeCount > 1 }),
      });
      const data = await res.json();
      if (!data.ok) {
        // API rejected -- still remove from local view
        console.warn(`Delete API returned: ${data.error}`);
      }
    } catch {
      // Network error -- still remove from local view
    }
    for (const q of group.queries) {
      removeSavedTracker(q.id);
    }
    setGroups((prev) => prev.filter((g) => g.group.primaryId !== group.primaryId));
  };

  const refetchActive = () => {
    fetch('/api/queries/active')
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok || !data.data?.queries) return;
        const serverQueries: ActiveQuery[] = data.data.queries;
        const localTokens = new Set(
          isAuthenticated
            ? []
            : getSavedTrackers().filter((t) => t.deleteToken).map((t) => t.id),
        );
        const display: DisplayQuery[] = serverQueries.map((q) => ({
          id: q.id,
          origin: q.origin,
          destination: q.destination,
          originName: q.originName,
          destinationName: q.destinationName,
          dateFrom: q.dateFrom,
          dateTo: q.dateTo,
          groupId: q.groupId,
          active: q.active,
          createdAt: q.createdAt,
          snapshotCount: q.snapshotCount,
          lastScrapedAt: q.lastScrapedAt,
          status: q.active ? 'active' : 'paused',
          hasDeleteToken: localTokens.has(q.id),
          scrapeStatus: q.lastScrapeStatus,
          scrapeError: q.lastScrapeError,
        }));
        setGroups(toDisplayGroups(display));
      })
      .catch(() => {});
  };

  const handleTogglePause = async (entry: DisplayGroup) => {
    const { group } = entry;
    const currentlyActive = entry.status === 'active';
    const nextActive = !currentlyActive;
    const token = getDeleteToken(group.primaryId);
    const res = await fetch(`/api/queries/${group.primaryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteToken: token, active: nextActive }),
    });
    const data = await res.json();
    if (!data.ok) return;
    setGroups((prev) =>
      prev.map((g) =>
        g.group.primaryId !== group.primaryId
          ? g
          : {
              ...g,
              status: nextActive ? 'active' : 'paused',
              group: {
                ...g.group,
                anyActive: nextActive,
                anyPaused: !nextActive,
                queries: g.group.queries.map((q) => ({
                  ...q,
                  active: nextActive,
                  status: nextActive ? 'active' : 'paused',
                })),
              },
            }
      )
    );
  };

  if (groups.length === 0) {
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
        {groups.map((entry) => {
          const { group, status, aggregate } = entry;
          const extraDestinations = group.destinations.length - 1;
          const primaryToken = getDeleteToken(group.primaryId);
          const primaryLabel = group.queries.find((q) => q.id === group.primaryId)?.label;
          return (
            <div key={group.primaryId} className={styles.card}>
              <button
                className={styles.remove}
                onClick={() => handleRemove(entry)}
                title="Remove"
                aria-label="Remove tracker"
              >
                &times;
              </button>

              {status === 'deleted' ? (
                <div className={styles.content}>
                  <div className={styles.route}>
                    <span className={styles.code}>{group.origin}</span>
                    <span className={styles.arrow}>&rarr;</span>
                    <span className={styles.code}>{group.destination}</span>
                    {extraDestinations > 0 && (
                      <span className={styles.dates}>+ {extraDestinations} more</span>
                    )}
                  </div>
                  <span className={`${styles.badge} ${styles.badgeDeleted}`}>Unavailable</span>
                </div>
              ) : (
                <Link href={`/q/${group.primaryId}`} className={styles.link}>
                  <div className={styles.content}>
                    {primaryLabel && (
                      <span className={styles.label}>{primaryLabel}</span>
                    )}
                    <div className={styles.route}>
                      <span className={styles.code}>{group.origin}</span>
                      <span className={styles.arrow}>&rarr;</span>
                      <span className={styles.code}>{group.destination}</span>
                      {extraDestinations > 0 && (
                        <span className={styles.dates}>+ {extraDestinations} more</span>
                      )}
                    </div>
                    <span className={styles.dates}>
                      {formatDate(group.dateFrom)} &mdash; {formatDate(group.dateTo)}
                    </span>
                    <div className={styles.meta}>
                      {group.routeCount > 1 && (
                        <span className={styles.snapshots}>
                          {group.routeCount} charts
                        </span>
                      )}
                      {group.snapshotCount > 0 && (
                        <span className={styles.snapshots}>
                          {group.snapshotCount} price{group.snapshotCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {group.lastScrapedAt && (
                        <span className={styles.lastScrape}>
                          <ScrapeStatusDot
                            status={aggregate.status}
                            error={aggregate.error}
                            lastScrapedAt={aggregate.startedAt}
                          />
                          {timeAgo(group.lastScrapedAt)}
                        </span>
                      )}
                    </div>
                    <div className={styles.cardActions}>
                      <span className={`${styles.badge} ${
                        status === 'active' ? styles.badgeActive
                          : status === 'paused' ? styles.badgePaused
                          : styles.badgeExpired
                      }`}>
                        {status === 'active' ? 'Tracking' : status === 'paused' ? 'Paused' : 'Expired'}
                      </span>
                      {status === 'active' && (
                        <ForceScrapeButton
                          queryId={group.primaryId}
                          deleteToken={primaryToken}
                          onScraped={(result) => { if (result.accepted) refetchActive(); }}
                          ariaLabel="Refresh prices now"
                        />
                      )}
                      {(status === 'active' || status === 'paused') && (
                        <button
                          className={styles.pauseBtn}
                          onClick={(e) => {
                            e.preventDefault();
                            handleTogglePause(entry);
                          }}
                          title={status === 'active' ? 'Pause tracking' : 'Resume tracking'}
                        >
                          {status === 'active' ? '⏸' : '▶'}
                        </button>
                      )}
                    </div>
                  </div>
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
