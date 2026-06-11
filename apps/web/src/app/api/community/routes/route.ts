import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { redis } from '@/lib/redis';

interface RouteInfo {
  origin: string;
  destination: string;
  snapshotCount: number;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  airlines: string[];
  latestScrapedAt: string;
}

const CACHE_KEY = 'community:routes';
const CACHE_TTL = 300; // 5 minutes
const LOCK_KEY = 'community:routes:lock';
const LOCK_TTL = 10; // seconds a single rebuild may hold the lock
const MAX_ROUTES = 200;
const MAX_AIRLINES_PER_ROUTE = 20;

async function readCache(): Promise<RouteInfo[] | null> {
  if (!redis) return null;
  try {
    const hit = await redis.get(CACHE_KEY);
    return hit ? (JSON.parse(hit) as RouteInfo[]) : null;
  } catch {
    return null;
  }
}

async function writeCache(value: RouteInfo[]): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(CACHE_KEY, JSON.stringify(value), 'EX', CACHE_TTL);
  } catch {
    // Cache write best effort; the response is served regardless.
  }
}

/**
 * Builds the route summary with a bounded number of queries: one groupBy for
 * per-route aggregates (count, price stats, latest scrape) and one distinct
 * query for the airline list across the selected routes. This replaces the old
 * ~401 sequential per-route queries.
 */
async function buildRoutes(): Promise<RouteInfo[]> {
  const grouped = await prisma.communitySnapshot.groupBy({
    by: ['origin', 'destination'],
    _count: { id: true },
    _avg: { price: true },
    _min: { price: true },
    _max: { price: true, scrapedAt: true },
    orderBy: { _count: { id: 'desc' } },
    take: MAX_ROUTES,
  });

  if (grouped.length === 0) return [];

  type GroupedRoute = (typeof grouped)[number];
  type AirlineRow = { origin: string; destination: string; airline: string };

  const routeKeys = new Set(grouped.map((r: GroupedRoute) => `${r.origin}-${r.destination}`));

  // One query for all airline rows on the selected routes, deduplicated in
  // memory per route rather than one query per route.
  const airlineRows = await prisma.communitySnapshot.findMany({
    where: {
      OR: grouped.map((r: GroupedRoute) => ({ origin: r.origin, destination: r.destination })),
    },
    select: { origin: true, destination: true, airline: true },
    distinct: ['origin', 'destination', 'airline'],
  });

  const airlinesByRoute = new Map<string, string[]>();
  for (const row of airlineRows as AirlineRow[]) {
    const key = `${row.origin}-${row.destination}`;
    if (!routeKeys.has(key)) continue;
    const list = airlinesByRoute.get(key) ?? [];
    if (list.length < MAX_AIRLINES_PER_ROUTE) {
      list.push(row.airline);
      airlinesByRoute.set(key, list);
    }
  }

  return grouped.map((r: GroupedRoute) => {
    const key = `${r.origin}-${r.destination}`;
    return {
      origin: r.origin,
      destination: r.destination,
      snapshotCount: r._count.id,
      avgPrice: Math.round(r._avg.price ?? 0),
      minPrice: r._min.price ?? 0,
      maxPrice: r._max.price ?? 0,
      airlines: airlinesByRoute.get(key) ?? [],
      latestScrapedAt: r._max.scrapedAt?.toISOString() ?? '',
    };
  });
}

/**
 * Returns the cached route summary, rebuilding it on a miss. A short Redis lock
 * guards the rebuild so concurrent misses do not all hit the database at once
 * (thundering herd). Requests that lose the lock wait briefly for the winner to
 * populate the cache before computing as a last resort.
 */
async function getRoutes(): Promise<RouteInfo[]> {
  const cached = await readCache();
  if (cached) return cached;

  if (!redis) {
    return buildRoutes();
  }

  let gotLock = false;
  try {
    gotLock = (await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL, 'NX')) === 'OK';
  } catch {
    // A Redis error means we did not get the lock; fall through to polling.
  }

  if (!gotLock) {
    // Another request is rebuilding. Poll briefly for the populated cache so we
    // serve its result instead of duplicating the work.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ready = await readCache();
      if (ready) return ready;
    }
    // Winner did not finish in time; compute without the lock as a fallback.
    return buildRoutes();
  }

  try {
    const result = await buildRoutes();
    await writeCache(result);
    return result;
  } finally {
    try {
      await redis.del(LOCK_KEY);
    } catch {
      // Lock will expire on its own.
    }
  }
}

export async function GET() {
  const routes = await getRoutes();
  return apiSuccess(routes);
}
