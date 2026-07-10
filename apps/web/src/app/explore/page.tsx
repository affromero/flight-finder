export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { formatCurrency } from '@/lib/currency';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Footer } from '@/components/Footer';
import styles from './page.module.css';

interface RouteData {
  origin: string;
  destination: string;
  count: number;
  currency: string;
  avgPrice: number;
  minPrice: number;
  airlines: string[];
}

async function getRoutes(): Promise<RouteData[]> {
  // Group by currency too: min/avg across mixed currencies is meaningless.
  // A route's displayed prices come from its dominant currency's snapshots.
  const raw = await prisma.communitySnapshot.groupBy({
    by: ['origin', 'destination', 'currency'],
    _count: { id: true },
    _avg: { price: true },
    _min: { price: true },
  });

  const byRoute = new Map<string, { count: number; best: (typeof raw)[number] }>();
  for (const g of raw) {
    const key = `${g.origin}-${g.destination}`;
    const entry = byRoute.get(key);
    if (!entry) {
      byRoute.set(key, { count: g._count.id, best: g });
    } else {
      entry.count += g._count.id;
      if (g._count.id > entry.best._count.id) entry.best = g;
    }
  }

  const top = Array.from(byRoute.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);

  const routes: RouteData[] = [];

  for (const { count, best } of top) {
    const airlines = await prisma.communitySnapshot.findMany({
      where: { origin: best.origin, destination: best.destination },
      select: { airline: true },
      distinct: ['airline'],
      take: 10,
    });

    routes.push({
      origin: best.origin,
      destination: best.destination,
      count,
      currency: best.currency,
      avgPrice: Math.round(best._avg.price ?? 0),
      minPrice: Math.round(best._min.price ?? 0),
      airlines: airlines.map((a: { airline: string }) => a.airline),
    });
  }

  return routes;
}

export default async function ExplorePage() {
  const routes = await getRoutes();

  const contributorCount = await prisma.communityApiKey.count({
    where: { active: true, snapshotCount: { gt: 0 } },
  });

  const totalSnapshots = await prisma.communitySnapshot.count();

  return (
    <main className={styles.root}>
      <div className={styles.topBar}>
        <ThemeToggle />
      </div>

      <div className={styles.hero}>
        <h1 className={styles.title}>
          <Link href="/">Flight Finder</Link>
          {' '}
          <span className={styles.titleAccent}>Explore</span>
        </h1>
        <p className={styles.tagline}>
          Community-sourced flight price data from {contributorCount} contributor{contributorCount !== 1 ? 's' : ''}
        </p>
        <p className={styles.stats}>
          {totalSnapshots.toLocaleString()} price points across {routes.length} routes
        </p>
      </div>

      {routes.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No community data yet</p>
          <p className={styles.emptyText}>
            Self-host Flight Finder and opt in to community sharing to help build the
            world&apos;s first open flight price database.
          </p>
          <Link href="/" className={styles.emptyLink}>
            Get started
          </Link>
        </div>
      ) : (
        <div className={styles.grid}>
          {routes.map((route) => (
            <Link
              key={`${route.origin}-${route.destination}`}
              href={`/explore/${route.origin}-${route.destination}`}
              className={styles.card}
            >
              <div className={styles.cardRoute}>
                <span className={styles.cardCode}>{route.origin}</span>
                <span className={styles.cardArrow}>&rarr;</span>
                <span className={styles.cardCode}>{route.destination}</span>
              </div>
              <div className={styles.cardPrices}>
                <div className={styles.cardPrice}>
                  <span className={styles.cardPriceLabel}>from</span>
                  <span className={styles.cardPriceValue}>{formatCurrency(route.minPrice, route.currency)}</span>
                </div>
                <div className={styles.cardPrice}>
                  <span className={styles.cardPriceLabel}>avg</span>
                  <span className={styles.cardPriceValue}>{formatCurrency(route.avgPrice, route.currency)}</span>
                </div>
              </div>
              <div className={styles.cardMeta}>
                <span className={styles.cardAirlines}>
                  {route.airlines.slice(0, 3).join(', ')}
                  {route.airlines.length > 3 ? ` +${route.airlines.length - 3}` : ''}
                </span>
                <span className={styles.cardCount}>
                  {route.count} pts
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Footer />
    </main>
  );
}
