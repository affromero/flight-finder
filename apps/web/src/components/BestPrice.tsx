import { getTranslations } from 'next-intl/server';
import { formatCurrency } from '@/lib/currency';
import { safeHttpUrl } from '@/lib/safe-url';
import { airTimeMinutes, formatMinutes } from '@/lib/scraper/duration';
import { latestFlightObservations, flightComparisonCurrency, lowestFlightFare } from '@/lib/flight-pricing';
import { filterSnapshotsByTrackerFilters, type TrackerSnapshotFilters } from '@/lib/snapshot-filters';
import { ScrapeTime } from './PriceHistorySection';
import styles from './BestPrice.module.css';

interface Snapshot {
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  layovers?: unknown;
  departureTime: string | null;
  arrivalTime: string | null;
  duration: string | null;
  vpnCountry: string | null;
  scrapedAt: string;
  status?: string;
  travelDate?: string;
  flightId?: string | null;
  flightNumber?: string | null;
}

interface Props {
  snapshots: Snapshot[];
  currency?: string | null;
  filters?: TrackerSnapshotFilters;
  route?: { origin: string; destination: string };
}

export async function BestPrice({ snapshots, currency, filters, route }: Props) {
  const t = await getTranslations('BestPrice');
  const latest = latestFlightObservations(snapshots, route);
  const comparisonCurrency = flightComparisonCurrency(latest, currency) ?? flightComparisonCurrency(snapshots, currency);
  const qualifying = (observations: Snapshot[]) => filters ? filterSnapshotsByTrackerFilters(observations, filters) : observations;
  const best = lowestFlightFare(qualifying(latest), comparisonCurrency);
  const historical = lowestFlightFare(qualifying(snapshots), comparisonCurrency);
  if (!best && !historical) return null;
  // Duration is gate-to-gate, so on a connecting fare most of the difference
  // between two similar itineraries is ground time. Issue #190.
  const airTime = best ? airTimeMinutes(best.duration, best.layovers) : null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.label}>{t('latestObservedPrice')}</span>
      </div>
      {best ? (
        <div className={styles.content} role="region" aria-label={t('latestObservedPrice')}>
          <span className={styles.price}>
            {formatCurrency(best.price, best.currency)}
          </span>
          <div className={styles.details}>
            <span className={styles.airline}>{best.airline}</span>
            <span className={styles.meta}>
              {best.stops === 0 ? t('nonstop') : t('stops', { count: best.stops })}
              {best.duration && ` · ${best.duration}`}
              {airTime !== null && ` (${t('airTime', { time: formatMinutes(airTime) })})`}
              {(best.departureTime || best.arrivalTime) && ` · ${best.departureTime ?? '?'} - ${best.arrivalTime ?? '?'}`}
            </span>
            <span className={styles.meta}>{t('observedAt')}: <ScrapeTime iso={best.scrapedAt} /></span>
          </div>
          {safeHttpUrl(best.bookingUrl) && (
            <a
              href={safeHttpUrl(best.bookingUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.bookButton}
            >
              {t('bookOn', { airline: best.airline })}
            </a>
          )}
        </div>
      ) : <p className={styles.content}>{t('noLatestFare')}</p>}
      {historical && (
        <aside className={styles.history} aria-label={t('historicalLow')}>
          {t('historicalLow')}: {formatCurrency(historical.price, historical.currency)}
          {' · '}<ScrapeTime iso={historical.scrapedAt} />
        </aside>
      )}
    </div>
  );
}
