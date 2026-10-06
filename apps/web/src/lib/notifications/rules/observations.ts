import type { Prisma, Query } from '@/generated/prisma/client';
import { latestFlightObservationEntries, availableFlightFares, lowestFlightFare, flightComparisonCurrency } from '@/lib/flight-pricing';
import { filterSnapshotsByTrackerFilters } from '@/lib/snapshot-filters';

/** Latest observations must win before eligibility filters can discard them. */
export async function ruleObservations(tx: Prisma.TransactionClient, query: Query, baselineFrom?: Date | null) {
  const rows = await tx.priceSnapshot.findMany({ where: { queryId: query.id }, orderBy: [{ scrapedAt: 'desc' }, { id: 'asc' }] });
  const entries = latestFlightObservationEntries(rows.map(row => ({ ...row,
    travelDate: row.travelDate.toISOString().slice(0, 10), scrapedAt: row.scrapedAt.toISOString() })), query);
  const filtered = new Set(filterSnapshotsByTrackerFilters(entries.map(entry => entry.snapshot), query));
  const eligible = entries.filter(entry => filtered.has(entry.snapshot) && (!baselineFrom || entry.snapshot.scrapedAt >= baselineFrom.toISOString()));
  return { entries: eligible, comparisonCurrency: flightComparisonCurrency(eligible.map(entry => entry.snapshot), query.currency) };
}

export type RuleObservations = Awaited<ReturnType<typeof ruleObservations>>;

export function ruleFare(observations: RuleObservations, rule: { currency: string; flightId: string | null }, cycleStartedAt?: Date) {
  const scoped = observations.entries.filter(entry => (rule.flightId === null || entry.flightId === rule.flightId)
    && (!cycleStartedAt || entry.snapshot.scrapedAt >= cycleStartedAt.toISOString())).map(entry => entry.snapshot);
  return lowestFlightFare(scoped, rule.currency);
}

export function ruleFlightChoices(observations: RuleObservations) {
  const snapshots = observations.entries.map(entry => entry.snapshot);
  const currencies = new Set(snapshots.map(snapshot => snapshot.currency));
  const available = new Set([...currencies].flatMap(currency => availableFlightFares(snapshots, currency)));
  return observations.entries.filter(entry => entry.flightId !== null && available.has(entry.snapshot)).map(entry => ({
    id: entry.flightId!, label: `${entry.snapshot.airline} ${entry.snapshot.flightNumber ?? entry.snapshot.departureTime ?? ''} ${entry.snapshot.travelDate}`,
    price: entry.snapshot.price, currency: entry.snapshot.currency,
  })).filter((choice, index, choices) => choices.findIndex(row => row.id === choice.id && row.currency === choice.currency) === index);
}
