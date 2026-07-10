'use client';

import { useState } from 'react';
import { formatCurrency } from '@/lib/currency';
import { safeHttpUrl } from '@/lib/safe-url';
import { useHydrated } from '@/lib/use-hydrated';
import styles from './PriceHistory.module.css';
import type { Snapshot } from './PriceHistory';

// The full-history log can run to flights x scrapes rows. Collapsed by default;
// when expanded this bounds the DOM, and the note row reports anything trimmed.
const MAX_HISTORY_ROWS = 200;

/** Stable identity for one flight across scrapes. */
function flightKey(s: Snapshot): string {
  return s.flightId ?? `${s.airline}|${s.flightNumber ?? ''}|${s.departureTime ?? ''}|${s.arrivalTime ?? ''}`;
}

function formatScrapeTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * Render a scrape timestamp in each visitor's OWN local timezone, robustly.
 * The server and the first client render both format in UTC, so the hydrated
 * markup matches and React reports no mismatch (#418). Immediately after mount
 * we re-render in the visitor's local zone via Intl's default (no timeZone
 * option). Each person therefore sees their own local time and there is no
 * hydration warning. Travel dates stay absolute and are handled elsewhere; only
 * a moment-in-time like a scrape timestamp is localized to the viewer.
 */
function ScrapeTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  // UTC until mounted (so it matches the server-rendered markup), then the
  // visitor's own local zone (omitting timeZone uses Intl's local default).
  return <>{formatScrapeTime(iso, hydrated ? undefined : 'UTC')}</>;
}

function flightName(s: Snapshot): string {
  return `${s.airline}${s.flightNumber ? ` ${s.flightNumber}` : ''}`;
}

function timesLabel(s: Snapshot): string | null {
  if (!s.departureTime && !s.arrivalTime) return null;
  return `${s.departureTime ?? '?'} - ${s.arrivalTime ?? '?'}`;
}

function stopsLabel(s: Snapshot): string {
  return s.stops === 0 ? 'Direct' : `${s.stops} stop${s.stops > 1 ? 's' : ''}`;
}

/**
 * Map each snapshot id to the same flight's immediately-older snapshot, so the
 * Change column reflects this exact flight's last move rather than the airline's.
 */
function buildPreviousMap(snapshots: Snapshot[]): Map<string, Snapshot | null> {
  const byFlight = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    const arr = byFlight.get(flightKey(s)) ?? [];
    arr.push(s);
    byFlight.set(flightKey(s), arr);
  }
  const prev = new Map<string, Snapshot | null>();
  for (const series of byFlight.values()) {
    const asc = [...series].sort((a, b) => new Date(a.scrapedAt).getTime() - new Date(b.scrapedAt).getTime());
    asc.forEach((s, i) => prev.set(s.id, asc[i - 1] ?? null));
  }
  return prev;
}

function TrendCell({ current, previous }: { current: Snapshot; previous: Snapshot | null }) {
  const diff = previous ? current.price - previous.price : 0;
  if (!previous || Math.abs(diff) < 1) {
    return (
      <td>
        <span className={styles.trendStable}>&mdash;</span>
      </td>
    );
  }
  const up = diff > 0;
  return (
    <td>
      <span className={up ? styles.trendUp : styles.trendDown}>
        {up ? '+' : '-'}{formatCurrency(Math.abs(diff), current.currency)}
      </span>
    </td>
  );
}

function FlightRow({
  s,
  previous,
  showDate,
}: {
  s: Snapshot;
  previous: Snapshot | null;
  showDate: boolean;
}) {
  return (
    <tr>
      {showDate && <td className={styles.date}><ScrapeTime iso={s.scrapedAt} /></td>}
      <td>{flightName(s)}</td>
      <td className={styles.times}>{timesLabel(s)}</td>
      <td className={styles.price}>
        {formatCurrency(s.price, s.currency)}
      </td>
      <TrendCell current={s} previous={previous} />
      <td className={styles.stops}>{stopsLabel(s)}</td>
      <td className={styles.seats}>
        {s.status === 'sold_out' ? (
          <span className={styles.soldOut}>Sold out</span>
        ) : s.seatsLeft !== null ? (
          <span className={s.seatsLeft <= 3 ? styles.seatsLow : styles.seatsNormal}>{s.seatsLeft} left</span>
        ) : null}
      </td>
      <td>
        {s.status === 'sold_out' || !safeHttpUrl(s.bookingUrl) ? (
          <span className={styles.soldOutLabel}>&mdash;</span>
        ) : (
          <a href={safeHttpUrl(s.bookingUrl)} target="_blank" rel="noopener noreferrer" className={styles.bookLink}>
            Book
          </a>
        )}
      </td>
    </tr>
  );
}

/**
 * One country section of the price history. Default view is a flat, cheapest-
 * first list of the latest scrape only: a clean "what's bookable right now"
 * snapshot. "Show full history" reveals the complete chronological log
 * (newest first), where each row's Change is measured against the same flight's
 * previous scrape. Issue #89: the earlier grouped-by-flight view ordered rows by
 * lifetime-cheapest price, so flights last seen days ago interleaved with live
 * ones and it was impossible to read today's situation at a glance.
 */
export function PriceHistorySection({ snapshots }: { snapshots: Snapshot[] }) {
  const [expanded, setExpanded] = useState(false);
  if (snapshots.length === 0) return null;

  const previousMap = buildPreviousMap(snapshots);

  // Latest scrape: every snapshot stamped with the most recent scrapedAt. One
  // createMany per run shares a timestamp, so this is exactly that run's flights.
  const latestScrapedAt = snapshots.reduce(
    (max, s) => (s.scrapedAt > max ? s.scrapedAt : max),
    snapshots[0]!.scrapedAt,
  );
  const current = Array.from(
    snapshots
      .filter((s) => s.scrapedAt === latestScrapedAt)
      .reduce((m, s) => {
        const existing = m.get(flightKey(s));
        if (!existing || s.price < existing.price) m.set(flightKey(s), s);
        return m;
      }, new Map<string, Snapshot>())
      .values(),
  ).sort((a, b) => (a.price !== b.price ? a.price - b.price : a.airline.localeCompare(b.airline)));

  const history = [...snapshots].sort((a, b) => {
    const t = new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime();
    return t !== 0 ? t : a.price - b.price;
  });
  const shownHistory = history.slice(0, MAX_HISTORY_ROWS);
  const hiddenCount = history.length - shownHistory.length;
  const hasHistory = snapshots.length > current.length;

  return (
    <div className={styles.section}>
      <div className={styles.caption}>
        Latest check &middot; <ScrapeTime iso={latestScrapedAt} /> &middot; {current.length} flight
        {current.length === 1 ? '' : 's'}
      </div>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Airline</th>
              <th>Times</th>
              <th>Price</th>
              <th>Change</th>
              <th>Stops</th>
              <th>Seats</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {current.map((s) => (
              <FlightRow key={s.id} s={s} previous={previousMap.get(s.id) ?? null} showDate={false} />
            ))}
          </tbody>
        </table>
      </div>

      {hasHistory && (
        <button
          type="button"
          className={styles.historyToggle}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide full history' : `Show full history (${snapshots.length} checks)`}
        </button>
      )}

      {expanded && (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Airline</th>
                <th>Times</th>
                <th>Price</th>
                <th>Change</th>
                <th>Stops</th>
                <th>Seats</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shownHistory.map((s) => (
                <FlightRow key={s.id} s={s} previous={previousMap.get(s.id) ?? null} showDate />
              ))}
              {hiddenCount > 0 && (
                <tr>
                  <td colSpan={8} className={styles.truncationNote}>
                    Showing the latest {MAX_HISTORY_ROWS} of {history.length} checks.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
