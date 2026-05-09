/**
 * Date-pair expansion for the scrape pipeline.
 *
 * Issue #65: queries with a flexibility window (e.g. "Nov 9 +/- 2 days") store
 * dateFrom=Nov 7, dateTo=Nov 11, flexibility=2. The scrape orchestrator must
 * expand this into per-day searches for one-way and a sampled grid for
 * round-trip; otherwise only dateFrom is ever queried and the rest of the
 * window is silently skipped.
 *
 * Invariant from parse-query.ts: continuous range queries store
 * `dateTo - dateFrom = 2 * flexibility`. Round-trip stores
 * dateFrom = (intended outbound) - flex and dateTo = (intended return) + flex,
 * so outbound flex window is [dateFrom, dateFrom + 2*flex] and return flex
 * window is [dateTo - 2*flex, dateTo].
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface ScrapeDatePair {
  outbound: Date;
  return_: Date;
}

export interface ExpandQueryDatesOptions {
  /** Max one-way pairs across the [dateFrom, dateTo] window. */
  oneWayCap?: number;
}

/** Convert a Date to an ISO calendar day (UTC). */
function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

function addDaysUtc(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

/**
 * Pick `count` evenly-spaced indices from [0, length-1] inclusive. Always
 * returns the endpoints when count >= 2 and length >= 2. count == 1 returns
 * [0]. count == 0 returns [].
 */
function evenIndices(length: number, count: number): number[] {
  if (length <= 0 || count <= 0) return [];
  if (count === 1) return [0];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    result.push(Math.round((i * (length - 1)) / (count - 1)));
  }
  // Defensive dedupe in case rounding produced duplicates at the seam of a
  // very small range; preserves insertion order.
  return Array.from(new Set(result));
}

/**
 * Expand a query's stored date window into the (outbound, return) pairs the
 * scraper actually iterates.
 *
 * One-way:
 *   - Emits one pair per day in [dateFrom, dateTo] inclusive.
 *   - Each pair has outbound == return (matches the upstream invariant for
 *     one-way: only dateFrom is sent to the upstream URL).
 *   - If the range is wider than `oneWayCap`, samples evenly-spaced days,
 *     always including dateFrom and dateTo.
 *
 * Round-trip:
 *   - Always emits a single (dateFrom, dateTo) pair regardless of
 *     flexibility. PriceSnapshot.flightId is keyed by airline + outbound
 *     travelDate only, so iterating multiple (outbound, return) pairs would
 *     collapse same-outbound flights with different returns. Google
 *     Flights' calendar grid already surfaces nearby return dates within a
 *     single search, so the loss is small. Adding RT pair iteration would
 *     require a returnTravelDate column on PriceSnapshot and changes to
 *     flightId; that is a future migration, not part of this fix.
 */
export function expandQueryDates(
  query: { dateFrom: Date; dateTo: Date; flexibility: number; tripType: string },
  options: ExpandQueryDatesOptions = {},
): ScrapeDatePair[] {
  const oneWayCap = options.oneWayCap ?? 7;

  const { dateFrom, dateTo, tripType } = query;
  const isOneWay = tripType === 'one_way';

  if (isOneWay) {
    const span = dayDiff(dateFrom, dateTo);
    if (span <= 0) {
      return [{ outbound: dateFrom, return_: dateFrom }];
    }
    const totalDays = span + 1;
    const indices = evenIndices(totalDays, Math.min(totalDays, oneWayCap));
    return indices.map((i) => {
      const day = addDaysUtc(dateFrom, i);
      return { outbound: day, return_: day };
    });
  }

  // Round-trip: single pair until flightId/dedupe gain return-date awareness.
  return [{ outbound: dateFrom, return_: dateTo }];
}

/**
 * Expand a continuous [dateFrom, dateTo] ISO range into evenly-spaced ISO
 * date strings, capped at `cap`. Used by the preview path which deals in
 * string dates rather than Date objects.
 */
export function expandContinuousRangeToDates(
  dateFrom: string,
  dateTo: string,
  cap = 7,
): string[] {
  const from = new Date(dateFrom + 'T00:00:00Z');
  const to = new Date(dateTo + 'T00:00:00Z');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return [dateFrom];
  }
  if (to.getTime() <= from.getTime()) {
    return [dateFrom];
  }
  const span = dayDiff(from, to);
  const totalDays = span + 1;
  const indices = evenIndices(totalDays, Math.min(totalDays, cap));
  return indices.map((i) => toIsoDay(addDaysUtc(from, i)));
}
