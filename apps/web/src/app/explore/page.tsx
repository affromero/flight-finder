export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Footer } from '@/components/Footer';
import styles from './page.module.css';

interface RouteData {
  origin: string;
  destination: string;
  count: number;
  avgPrice: number;
  minPrice: number;
  airlines: string[];
}

async function getRoutes(): Promise<RouteData[]> {
  const raw = await prisma.communitySnapshot.groupBy({
    by: ['origin', 'destination'],
    _count: { id: true },
    _avg: { price: true },
    _min: { price: true },
    orderBy: { _count: { id: 'desc' } },
    take: 100,
  });

  const routes: RouteData[] = [];

  for (const r of raw) {
    const airlines = await prisma.communitySnapshot.findMany({
      where: { origin: r.origin, destination: r.destination },
      select: { airline: true },
      distinct: ['airline'],
      take: 10,
    });

    routes.push({
      origin: r.origin,
      destination: r.destination,
      count: r._count.id,
      avgPrice: Math.round(r._avg.price ?? 0),
      minPrice: Math.round(r._min.price ?? 0),
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
                  <span className={styles.cardPriceValue}>${route.minPrice}</span>
                </div>
                <div className={styles.cardPrice}>
                  <span className={styles.cardPriceLabel}>avg</span>
                  <span className={styles.cardPriceValue}>${route.avgPrice}</span>
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
