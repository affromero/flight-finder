export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
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
  const t = await getTranslations('Explore');
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
          <span className={styles.titleAccent}>{t('explore')}</span>
        </h1>
        <p className={styles.tagline}>
          {t('tagline', { count: contributorCount })}
        </p>
        <p className={styles.stats}>
          {t('stats', { snapshots: totalSnapshots, routes: routes.length })}
        </p>
      </div>

      {routes.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t('emptyTitle')}</p>
          <p className={styles.emptyText}>
            {t('emptyText')}
          </p>
          <Link href="/" className={styles.emptyLink}>
            {t('getStarted')}
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
                  <span className={styles.cardPriceLabel}>{t('from')}</span>
                  <span className={styles.cardPriceValue}>{formatCurrency(route.minPrice, route.currency)}</span>
                </div>
                <div className={styles.cardPrice}>
                  <span className={styles.cardPriceLabel}>{t('avg')}</span>
                  <span className={styles.cardPriceValue}>{formatCurrency(route.avgPrice, route.currency)}</span>
                </div>
              </div>
              <div className={styles.cardMeta}>
                <span className={styles.cardAirlines}>
                  {route.airlines.slice(0, 3).join(', ')}
                  {route.airlines.length > 3 ? ` +${route.airlines.length - 3}` : ''}
                </span>
                <span className={styles.cardCount}>
                  {t('pts', { count: route.count })}
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
