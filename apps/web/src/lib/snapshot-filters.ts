import { parseDurationToMinutes } from '@/lib/scraper/duration';

export interface TrackerSnapshotFilters {
  maxPrice: number | null | undefined;
  maxStops: number | null | undefined;
  maxDurationHours: number | null | undefined;
  preferredAirlines: readonly string[] | null | undefined;
}

interface FilterableSnapshot {
  price: number;
  stops: number;
  duration: string | null;
  airline: string;
}

function airlineMatches(snapshotAirline: string, preferredAirline: string): boolean {
  const snapshot = snapshotAirline.trim().toLowerCase();
  const preferred = preferredAirline.trim().toLowerCase();
  if (!snapshot || !preferred) return false;
  // Snapshot airlines are provider display names, not normalized airline IDs,
  // so retroactive airline filtering is necessarily name-based.
  if (preferred.length < 4) {
    return (
      snapshot === preferred ||
      snapshot.startsWith(`${preferred} `) ||
      snapshot.endsWith(` ${preferred}`) ||
      snapshot.includes(` ${preferred} `)
    );
  }
  return snapshot.includes(preferred);
}

export function filterSnapshotsByTrackerFilters<T extends FilterableSnapshot>(
  snapshots: T[],
  filters: TrackerSnapshotFilters,
): T[] {
  const preferredAirlines = filters.preferredAirlines?.filter((airline) => airline.trim()) ?? [];

  return snapshots.filter((snapshot) => {
    if (filters.maxPrice !== null && filters.maxPrice !== undefined && snapshot.price > filters.maxPrice) {
      return false;
    }

    if (filters.maxStops !== null && filters.maxStops !== undefined && snapshot.stops > filters.maxStops) {
      return false;
    }

    if (filters.maxDurationHours !== null && filters.maxDurationHours !== undefined) {
      const minutes = parseDurationToMinutes(snapshot.duration);
      // Keep unknown durations: older/provider snapshots can lack a parseable
      // duration, and hiding them would drop otherwise valid historical fares.
      if (minutes !== null && minutes > filters.maxDurationHours * 60) return false;
    }

    if (preferredAirlines.length > 0 && !preferredAirlines.some((airline) => airlineMatches(snapshot.airline, airline))) {
      return false;
    }

    return true;
  });
}
