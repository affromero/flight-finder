'use client';

import { useState } from 'react';
import { currencySymbol } from '@/lib/currency';
import styles from './PriceHistory.module.css';

export interface Snapshot {
  id: string;
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  duration: string | null;
  flightId: string | null;
  flightNumber: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  seatsLeft: number | null;
  status: string;
  airlineDirectPrice: number | null;
  vpnCountry: string | null;
  scrapedAt: string;
}

// A long-running tracker accumulates one snapshot per flight per scrape, so a
// flight's history can run into the hundreds. Collapsing hides it by default;
// this bounds the expanded view so a single open flight cannot dump an unbounded
// number of rows into the DOM. The note row reports anything trimmed.
const MAX_HISTORY_ROWS = 60;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function PriceCell({ s }: { s: Snapshot }) {
  return (
    <td className={styles.price}>
      {currencySymbol(s.currency)}
      {s.price.toLocaleString()}
    </td>
  );
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
  const sym = currencySymbol(current.currency);
  return (
    <td>
      {diff > 0 ? (
        <span className={styles.trendUp}>+{sym}{Math.abs(diff).toFixed(0)}</span>
      ) : (
        <span className={styles.trendDown}>-{sym}{Math.abs(diff).toFixed(0)}</span>
      )}
    </td>
  );
}

function SeatsCell({ s }: { s: Snapshot }) {
  return (
    <td className={styles.seats}>
      {s.status === 'sold_out' ? (
        <span className={styles.soldOut}>Sold out</span>
      ) : s.seatsLeft !== null ? (
        <span className={s.seatsLeft <= 3 ? styles.seatsLow : styles.seatsNormal}>
          {s.seatsLeft} left
        </span>
      ) : null}
    </td>
  );
}

function BookCell({ s }: { s: Snapshot }) {
  return (
    <td>
      {s.status === 'sold_out' || !s.bookingUrl ? (
        <span className={styles.soldOutLabel}>&mdash;</span>
      ) : (
        <a href={s.bookingUrl} target="_blank" rel="noopener noreferrer" className={styles.bookLink}>
          Book
        </a>
      )}
    </td>
  );
}

/**
 * One flight's rows in the price-history table. `snapshots` arrives sorted
 * newest-first: [0] is the live summary shown by default, the rest is the
 * collapsed history. Trend is computed within this flight's own series, so the
 * change column reflects this exact flight's last move rather than the airline's.
 */
export function FlightHistoryGroup({ snapshots }: { snapshots: Snapshot[] }) {
  const [expanded, setExpanded] = useState(false);

  const latest = snapshots[0];
  if (!latest) return null;

  const history = snapshots.slice(1);
  const hasHistory = history.length > 0;
  const shownHistory = history.slice(0, MAX_HISTORY_ROWS);
  const hiddenCount = history.length - shownHistory.length;
  const totalChecks = snapshots.length;

  return (
    <tbody>
      <tr className={styles.summaryRow}>
        <td className={styles.date}>
          {hasHistory ? (
            <button
              type="button"
              className={styles.expandBtn}
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} earlier checks for ${flightName(latest)}`}
            >
              <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden="true">
                ▸
              </span>
              {formatDateTime(latest.scrapedAt)}
            </button>
          ) : (
            formatDateTime(latest.scrapedAt)
          )}
        </td>
        <td>
          {flightName(latest)}
          {hasHistory && <span className={styles.historyCount}> · {totalChecks} checks</span>}
        </td>
        <td className={styles.times}>{timesLabel(latest)}</td>
        <PriceCell s={latest} />
        <TrendCell current={latest} previous={history[0] ?? null} />
        <td className={styles.stops}>{stopsLabel(latest)}</td>
        <SeatsCell s={latest} />
        <BookCell s={latest} />
      </tr>

      {expanded &&
        shownHistory.map((s, i) => (
          <tr key={s.id} className={styles.historyRow}>
            <td className={`${styles.date} ${styles.historyDate}`}>{formatDateTime(s.scrapedAt)}</td>
            <td>{flightName(s)}</td>
            <td className={styles.times}>{timesLabel(s)}</td>
            <PriceCell s={s} />
            <TrendCell current={s} previous={history[i + 1] ?? null} />
            <td className={styles.stops}>{stopsLabel(s)}</td>
            <SeatsCell s={s} />
            <BookCell s={s} />
          </tr>
        ))}

      {expanded && hiddenCount > 0 && (
        <tr className={styles.historyRow}>
          <td colSpan={8} className={styles.truncationNote}>
            Showing the latest {MAX_HISTORY_ROWS} of {history.length} earlier checks.
          </td>
        </tr>
      )}
    </tbody>
  );
}
