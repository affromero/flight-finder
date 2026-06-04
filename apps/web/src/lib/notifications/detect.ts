import { prisma } from '@/lib/prisma';

/** A confirmed new-low price worth alerting on. */
export interface NewLowAlert {
  queryId: string;
  currentMin: number; // cheapest available fare found this cycle
  baseline: number; // the prior best price this low beats
  drop: number; // baseline - currentMin (always > 0)
  currency: string | null;
  airline: string;
  bookingUrl: string | null;
  travelDate: Date;
  flightNumber: string | null;
}

export interface DetectNewLowParams {
  query: { id: string; currency: string | null; lastNotifiedLowPrice: number | null };
  /** FetchRun ids produced for this query during the current scrape cycle. */
  currentRunIds: string[];
  /** Snapshots scraped before this instant are treated as history. */
  cycleStartedAt: Date;
  /** Minimum absolute drop (in the query's currency) required to fire. */
  floorAbs: number;
  /** Minimum fractional drop (0..1) required to fire; 0 disables the percentage gate. */
  floorPct: number;
}

/**
 * Decide whether the latest scrape produced a genuinely new low fare for a
 * query, worth pushing a notification about.
 *
 * "New low" means the cheapest currently-available fare beats BOTH the prior
 * historical best (any available snapshot scraped before this cycle) AND the
 * price of the last alert we already sent for this query (dedupe), by at least
 * the configured floor. The very first time a query is scraped there is no
 * baseline, so we stay silent and let that run establish it — this also keeps
 * the create-time preview scrape from firing a spurious alert.
 */
export async function detectNewLow(params: DetectNewLowParams): Promise<NewLowAlert | null> {
  const { query, currentRunIds, cycleStartedAt, floorAbs, floorPct } = params;
  if (currentRunIds.length === 0) return null;

  // Cheapest available fare found this cycle. Carry its booking details so the
  // notification can deep-link straight to the flight.
  const cheapest = await prisma.priceSnapshot.findFirst({
    where: { queryId: query.id, fetchRunId: { in: currentRunIds }, status: 'available' },
    orderBy: { price: 'asc' },
    select: {
      price: true,
      airline: true,
      bookingUrl: true,
      travelDate: true,
      currency: true,
      flightNumber: true,
    },
  });
  if (!cheapest) return null;
  const currentMin = cheapest.price;

  // Prior best across all history before this cycle. Scoped by scrapedAt rather
  // than fetchRunId so legacy snapshots with a null fetchRunId still count.
  const prior = await prisma.priceSnapshot.aggregate({
    where: { queryId: query.id, status: 'available', scrapedAt: { lt: cycleStartedAt } },
    _min: { price: true },
  });

  const baselineCandidates = [prior._min.price, query.lastNotifiedLowPrice].filter(
    (v): v is number => v != null,
  );
  // No baseline yet — establish it silently rather than alerting on first sight.
  if (baselineCandidates.length === 0) return null;
  const baseline = Math.min(...baselineCandidates);

  const drop = baseline - currentMin;
  if (drop < floorAbs) return null;
  if (floorPct > 0 && drop / baseline < floorPct) return null;

  return {
    queryId: query.id,
    currentMin,
    baseline,
    drop,
    currency: cheapest.currency ?? query.currency,
    airline: cheapest.airline,
    bookingUrl: cheapest.bookingUrl,
    travelDate: cheapest.travelDate,
    flightNumber: cheapest.flightNumber,
  };
}
