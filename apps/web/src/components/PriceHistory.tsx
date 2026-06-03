import { PriceHistorySection } from './PriceHistorySection';
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

function countryLabel(key: string): string {
  if (key === 'local' || key === 'all') return 'Local';
  return String.fromCodePoint(...key.split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + ' ' + key;
}

/**
 * Price history for one tracker route. Each country section (VPN multi-country
 * trackers split here; everything else is one "all" section) shows the latest
 * scrape as a flat, cheapest-first snapshot of what is bookable right now, with
 * the full chronological log tucked behind a toggle. See PriceHistorySection.
 */
export function PriceHistory({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length === 0) return null;

  const hasCountryData = snapshots.some((s) => s.vpnCountry);

  const countryGroups: Array<readonly [string, Snapshot[]]> = hasCountryData
    ? (() => {
        const groups = new Map<string, Snapshot[]>();
        for (const s of snapshots) {
          const key = s.vpnCountry ?? 'local';
          const arr = groups.get(key) ?? [];
          arr.push(s);
          groups.set(key, arr);
        }
        // Local first, then alphabetical
        return Array.from(groups.entries()).sort(([a], [b]) =>
          a === 'local' ? -1 : b === 'local' ? 1 : a.localeCompare(b)
        );
      })()
    : [['all', snapshots] as const];

  return (
    <div className={styles.root}>
      <h3 className={styles.title}>Price History</h3>
      {countryGroups.map(([key, items]) => (
        <div key={key}>
          {hasCountryData && <div className={styles.countryHeader}>{countryLabel(key)}</div>}
          <PriceHistorySection snapshots={items} />
        </div>
      ))}
    </div>
  );
}
