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
  /** Boundary between this cycle's fresh snapshots and history. Snapshots
   * scraped at/after this instant are "current"; earlier ones are history. */
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
  const { query, cycleStartedAt, floorAbs, floorPct } = params;

  // Only ever compare prices in the same currency. When the query has an
  // explicit currency, scope both queries to it so a stray or pre-change
  // snapshot in another currency can't produce a false drop (numerically
  // comparing 300 USD against 40000 JPY). Null currency means Google
  // auto-detects per locale, which is consistent within a query.
  const currencyFilter = query.currency ? { currency: query.currency } : {};

  // Cheapest available fare found this cycle. Carry its booking details so the
  // notification can deep-link straight to the flight.
  const cheapest = await prisma.priceSnapshot.findFirst({
    where: { queryId: query.id, status: 'available', scrapedAt: { gte: cycleStartedAt }, ...currencyFilter },
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

  // Prior best across all history before this cycle, in the SAME currency as the
  // cheapest fare. When the query has an explicit currency we use it; otherwise
  // (Google auto-detect, where VPN passes can differ by country) we fall back to
  // the cheapest snapshot's own currency so we never cross-compare e.g. JPY
  // against USD. Scoped by scrapedAt (not fetchRunId) so legacy null-fetchRunId
  // snapshots still count.
  const prior = await prisma.priceSnapshot.aggregate({
    where: {
      queryId: query.id,
      status: 'available',
      scrapedAt: { lt: cycleStartedAt },
      currency: query.currency ?? cheapest.currency,
    },
    _min: { price: true },
  });

  const baselineCandidates = [prior._min.price, query.lastNotifiedLowPrice].filter(
    (v): v is number => v != null,
  );
  // No baseline yet — establish it silently rather than alerting on first sight.
  if (baselineCandidates.length === 0) return null;
  const baseline = Math.min(...baselineCandidates);

  // Round to whole cents before comparing so IEEE-754 drift in the subtraction
  // (for example 100.10 - 99.90 landing at 0.2000000000000028) cannot push a
  // borderline drop just over or under the configured floor.
  const drop = Math.round((baseline - currentMin) * 100) / 100;
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
