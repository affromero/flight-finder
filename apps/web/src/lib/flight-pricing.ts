import { flightIdentifiers, flightDepartureAlias } from './scraper/identity/flight';

/** Exact marker emitted by the old preview-only sum of two one-way fares. */
const LEGACY_SPLIT_FARE_SUFFIX = ' (approx OW+OW)';

export function isLegacySplitFare(airline: unknown): boolean {
  return typeof airline === 'string' && airline.endsWith(LEGACY_SPLIT_FARE_SUFFIX);
}

/** Apply before database aggregation or pagination of actual flight fares. */
export const ACTUAL_FLIGHT_FARE_WHERE = {
  NOT: { airline: { endsWith: LEGACY_SPLIT_FARE_SUFFIX } },
};

export const LEGACY_SPLIT_PREVIEW_ERROR =
  'This preview contains separate one-way estimates. Search again for round-trip fares.';

interface FareObservation {
  price: number;
  currency: string;
  airline: string;
  scrapedAt: string;
  travelDate?: string;
  flightId?: string | null;
  flightNumber?: string | null;
  departureTime?: string | null;
  arrivalTime?: string | null;
  vpnCountry?: string | null;
  status?: string;
}

function observationScope(snapshot: FareObservation): string {
  return JSON.stringify([snapshot.travelDate?.slice(0, 10) ?? '', snapshot.currency, snapshot.vpnCountry ?? null]);
}

/** Latest observations retain sold-out rows until selection is complete. */
export function latestFlightObservations<T extends FareObservation>(
  snapshots: readonly T[],
  route: { origin: string; destination: string } = { origin: '', destination: '' },
): T[] {
  return latestFlightObservationEntries(snapshots, route).map(entry => entry.snapshot);
}

/** An ambiguous unnumbered observation cannot authorize a flight-specific rule. */
export function latestFlightObservationEntries<T extends FareObservation>(
  snapshots: readonly T[],
  route: { origin: string; destination: string } = { origin: '', destination: '' },
): { snapshot: T; flightId: string | null }[] {
  const numberedAliases = new Map<string, { availableAt?: string; identities: Set<string> }>();
  const availableLegacyAliases = new Map<string, string>();
  const identified = snapshots.filter(snapshot => !isLegacySplitFare(snapshot.airline)).map(snapshot => {
    const ids = flightIdentifiers(route.origin, route.destination, { ...snapshot, travelDate: snapshot.travelDate?.slice(0, 10) ?? '' });
    const scope = observationScope(snapshot);
    const departureAlias = flightDepartureAlias(route.origin, route.destination, { ...snapshot, travelDate: snapshot.travelDate?.slice(0, 10) ?? '' });
    const alias = departureAlias ? JSON.stringify([departureAlias, scope]) : null;
    const availableAt = snapshot.status !== 'sold_out' ? snapshot.scrapedAt : undefined;
    const legacy = !snapshot.flightNumber?.trim() && (!snapshot.flightId || snapshot.flightId === ids.flightIdLegacy);
    if (alias && legacy && availableAt && (!availableLegacyAliases.has(alias) || availableAt > availableLegacyAliases.get(alias)!)) {
      availableLegacyAliases.set(alias, availableAt);
    }
    if (alias && snapshot.flightNumber?.trim()) {
      const previous = numberedAliases.get(alias);
      if (previous) {
        previous.identities.add(ids.flightId);
        if (availableAt && (!previous.availableAt || availableAt > previous.availableAt)) previous.availableAt = availableAt;
      } else numberedAliases.set(alias, { availableAt, identities: new Set([ids.flightId]) });
    }
    return { snapshot, ids, scope, alias, legacy };
  });
  const latest = new Map<string, { snapshot: T; flightId: string | null }>();
  for (const { snapshot, ids, scope, alias, legacy } of identified) {
    const numbered = alias ? numberedAliases.get(alias) : undefined;
    if (legacy && numbered?.availableAt && numbered.availableAt > snapshot.scrapedAt) continue;
    const availableLegacyAt = alias ? availableLegacyAliases.get(alias) : undefined;
    if (!legacy && snapshot.status === 'sold_out' && numbered?.identities.size === 1
      && availableLegacyAt && availableLegacyAt >= snapshot.scrapedAt) continue;
    const legacyIdentity = legacy && numbered?.identities.size === 1 ? [...numbered.identities][0] : undefined;
    const identity = legacyIdentity ?? (snapshot.flightNumber?.trim() ? ids.flightId
      : legacy && alias ? alias : snapshot.flightId ?? JSON.stringify([ids.flightIdLegacy, snapshot.arrivalTime ?? '']));
    const key = JSON.stringify([identity, scope]);
    const previous = latest.get(key)?.snapshot;
    const newer = !previous || snapshot.scrapedAt > previous.scrapedAt;
    const tied = previous && snapshot.scrapedAt === previous.scrapedAt;
    if (newer || (tied && (snapshot.status === 'sold_out' && previous.status !== 'sold_out'
      || (snapshot.status ?? 'available') === (previous.status ?? 'available') && snapshot.price < previous.price))) {
      latest.set(key, { snapshot, flightId: snapshot.flightNumber?.trim() ? ids.flightId : legacyIdentity ?? null });
    }
  }
  return [...latest.values()];
}

/** Auto mode anchors comparisons to the newest available direct observation. */
export function flightComparisonCurrency(snapshots: readonly FareObservation[], requested?: string | null): string | null {
  if (requested) return requested;
  const available = snapshots.filter(snapshot => snapshot.status !== 'sold_out' && !isLegacySplitFare(snapshot.airline)
    && Number.isFinite(snapshot.price) && snapshot.price > 0);
  const direct = available.filter(snapshot => !snapshot.vpnCountry);
  const candidates = direct.length ? direct : available;
  return candidates.reduce<FareObservation | null>((latest, snapshot) => !latest || snapshot.scrapedAt > latest.scrapedAt
    || snapshot.scrapedAt === latest.scrapedAt && snapshot.currency.localeCompare(latest.currency) < 0 ? snapshot : latest, null)?.currency ?? null;
}

export function lowestFlightFare<T extends FareObservation>(snapshots: readonly T[], currency: string | null): T | null {
  return availableFlightFares(snapshots, currency).reduce<T | null>((best, snapshot) => {
    if (!best || snapshot.price < best.price || snapshot.price === best.price && snapshot.scrapedAt > best.scrapedAt) return snapshot;
    return best;
  }, null);
}

export function availableFlightFares<T extends FareObservation>(snapshots: readonly T[], currency: string | null): T[] {
  return snapshots.filter(snapshot => snapshot.currency === currency && snapshot.status !== 'sold_out'
    && !isLegacySplitFare(snapshot.airline) && Number.isFinite(snapshot.price) && snapshot.price > 0);
}
