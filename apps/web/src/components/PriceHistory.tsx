import { FlightHistoryGroup, type Snapshot } from './FlightHistoryGroup';
import styles from './PriceHistory.module.css';

/** Stable identity for one flight across scrapes. */
function flightKey(s: Snapshot): string {
  return s.flightId ?? `${s.airline}|${s.flightNumber ?? ''}|${s.departureTime ?? ''}|${s.arrivalTime ?? ''}`;
}

/**
 * Bucket snapshots by flight, each bucket sorted newest-first, and order the
 * buckets by their current (latest) price ascending so the cheapest live option
 * sits on top. Tie-break by most recently seen.
 */
function groupByFlight(snaps: Snapshot[]): Snapshot[][] {
  const groups = new Map<string, Snapshot[]>();
  for (const s of snaps) {
    const key = flightKey(s);
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }

  const buckets = Array.from(groups.values()).map((g) =>
    [...g].sort((a, b) => new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime())
  );

  buckets.sort((a, b) => {
    if (a[0]!.price !== b[0]!.price) return a[0]!.price - b[0]!.price;
    return new Date(b[0]!.scrapedAt).getTime() - new Date(a[0]!.scrapedAt).getTime();
  });

  return buckets;
}

export function PriceHistory({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length === 0) return null;

  const hasCountryData = snapshots.some((s) => s.vpnCountry);

  // Group by country for sectioned display (VPN multi-country trackers), then
  // by flight within each section. Without country data it is a single section.
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

  function countryLabel(key: string): string {
    if (key === 'local' || key === 'all') return 'Local';
    return String.fromCodePoint(...key.split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + ' ' + key;
  }

  return (
    <div className={styles.root}>
      <h3 className={styles.title}>Price History</h3>
      {countryGroups.map(([key, items]) => (
        <div key={key}>
          {hasCountryData && (
            <div className={styles.countryHeader}>{countryLabel(key)}</div>
          )}
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
              {groupByFlight(items).map((bucket) => (
                <FlightHistoryGroup key={flightKey(bucket[0]!)} snapshots={bucket} />
              ))}
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
