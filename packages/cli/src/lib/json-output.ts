// Machine readable output for automation: `--json` with `--view <id>` dumps a
// single tracker, otherwise the whole list. Plain TypeScript (no JSX) so the
// pure getters are unit testable by mocking the prisma client.
import { prisma } from '@/lib/prisma';

export interface JsonSnapshot {
  price: number;
  currency: string;
  airline: string;
  stops: number;
  duration: string | null;
  bookingUrl: string | null;
  travelDate: string;
  scrapedAt: string;
}

export interface JsonBestPrice {
  price: number;
  currency: string;
  airline: string;
  stops: number;
  duration: string | null;
  bookingUrl: string | null;
}

export interface JsonQuery {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  dateFrom: string;
  dateTo: string;
  tripType: string;
  cabinClass: string;
  currency: string | null;
  active: boolean;
  expired: boolean;
  expiresAt: string;
  lastScraped: string | null;
  snapshotCount: number;
  bestPrice: JsonBestPrice | null;
  snapshots: JsonSnapshot[];
}

export interface JsonQuerySummary {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  dateFrom: string;
  dateTo: string;
  currency: string | null;
  active: boolean;
  expired: boolean;
  expiresAt: string;
  lastScraped: string | null;
  snapshotCount: number;
  minPrice: number | null;
  maxPrice: number | null;
}

// A tracker is no longer live once it is paused, past its expiry, or its
// departure day has passed. Mirrors the list screen and the scrape sweep.
function isExpired(dateFrom: Date, expiresAt: Date, active: boolean): boolean {
  const now = new Date();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  return !active || expiresAt <= now || dateFrom < todayStart;
}

export async function getQueryJson(id: string): Promise<JsonQuery | null> {
  const row = await prisma.query.findUnique({
    where: { id },
    include: {
      snapshots: {
        where: { status: 'available' },
        orderBy: { scrapedAt: 'desc' },
      },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true },
      },
    },
  });
  if (!row) return null;

  const snapshots = row.snapshots;
  const best = snapshots.length > 0
    ? snapshots.reduce((min, s) => (s.price < min.price ? s : min), snapshots[0]!)
    : null;

  return {
    id: row.id,
    origin: row.origin,
    originName: row.originName,
    destination: row.destination,
    destinationName: row.destinationName,
    dateFrom: row.dateFrom.toISOString(),
    dateTo: row.dateTo.toISOString(),
    tripType: row.tripType,
    cabinClass: row.cabinClass,
    currency: row.currency,
    active: row.active,
    expired: isExpired(row.dateFrom, row.expiresAt, row.active),
    expiresAt: row.expiresAt.toISOString(),
    lastScraped: row.fetchRuns[0]?.startedAt.toISOString() ?? null,
    snapshotCount: snapshots.length,
    bestPrice: best
      ? {
          price: best.price,
          currency: best.currency,
          airline: best.airline,
          stops: best.stops,
          duration: best.duration,
          bookingUrl: best.bookingUrl,
        }
      : null,
    snapshots: snapshots.map((s) => ({
      price: s.price,
      currency: s.currency,
      airline: s.airline,
      stops: s.stops,
      duration: s.duration,
      bookingUrl: s.bookingUrl,
      travelDate: s.travelDate.toISOString(),
      scrapedAt: s.scrapedAt.toISOString(),
    })),
  };
}

export async function getQueryListJson(): Promise<JsonQuerySummary[]> {
  const rows = await prisma.query.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      snapshots: {
        where: { status: 'available' },
        orderBy: { price: 'asc' },
        select: { price: true },
      },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true },
      },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    origin: r.origin,
    originName: r.originName,
    destination: r.destination,
    destinationName: r.destinationName,
    dateFrom: r.dateFrom.toISOString(),
    dateTo: r.dateTo.toISOString(),
    currency: r.currency,
    active: r.active,
    expired: isExpired(r.dateFrom, r.expiresAt, r.active),
    expiresAt: r.expiresAt.toISOString(),
    lastScraped: r.fetchRuns[0]?.startedAt.toISOString() ?? null,
    snapshotCount: r.snapshots.length,
    minPrice: r.snapshots.length > 0 ? r.snapshots[0]!.price : null,
    maxPrice: r.snapshots.length > 0 ? r.snapshots[r.snapshots.length - 1]!.price : null,
  }));
}

/**
 * Print tracker JSON to stdout and exit. With a view id, dumps that one
 * tracker (exit 1 and a stderr error if it is missing); otherwise dumps the
 * full list. Never renders ink or opens a browser.
 */
export async function runJson(opts: { view?: string }): Promise<void> {
  let exitCode = 0;
  try {
    if (opts.view) {
      const data = await getQueryJson(opts.view);
      if (data) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.error(JSON.stringify({ error: `Tracker "${opts.view}" not found` }));
        exitCode = 1;
      }
    } else {
      const list = await getQueryListJson();
      console.log(JSON.stringify(list, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(exitCode);
}
