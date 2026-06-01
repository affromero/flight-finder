// Pure helpers for the Best Price card. Kept out of the .tsx so the unit test
// imports plain TypeScript and vitest never has to transpile JSX.

export interface BestPriceSnapshot {
  price: number;
  currency: string;
  airline: string;
  stops: number;
  duration: string | null;
  bookingUrl: string | null;
  scrapedAt: Date;
}

/** Lowest priced snapshot, or null when there is nothing to show. */
export function pickBest(snapshots: BestPriceSnapshot[]): BestPriceSnapshot | null {
  if (snapshots.length === 0) return null;
  return snapshots.reduce((min, s) => (s.price < min.price ? s : min), snapshots[0]!);
}

/**
 * Full booking line for the card, or null when there is no url. The url is
 * never truncated: a sliced link is an incomplete link that 404s (issue 96).
 */
export function formatBookingLine(url: string | null): string | null {
  if (!url) return null;
  return `Book: ${url}`;
}
