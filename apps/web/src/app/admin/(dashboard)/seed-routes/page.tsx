import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/prisma';
import { SeedRouteRow } from './SeedRouteRow';
import { SeedRouteForm } from './SeedRouteForm';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function SeedRoutesPage() {
  const t = await getTranslations('AdminSeedRoutes');
  const seeds = await prisma.query.findMany({
    where: { isSeed: true },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { snapshots: true, fetchRuns: true } },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true },
      },
    },
  });

  // Get unique airlines seen across all seed snapshots
  const airlinesByQuery = await prisma.priceSnapshot.groupBy({
    by: ['queryId', 'airline'],
    where: { queryId: { in: seeds.map((s) => s.id) } },
  });

  const airlinesMap = new Map<string, string[]>();
  for (const row of airlinesByQuery) {
    const list = airlinesMap.get(row.queryId) ?? [];
    list.push(row.airline);
    airlinesMap.set(row.queryId, list);
  }

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.description}>
        {t('description')}
      </p>

      <SeedRouteForm />

      {seeds.length === 0 ? (
        <p className={styles.empty}>{t('empty')}</p>
      ) : (
        <div className={styles.list}>
          {seeds.map((s) => (
            <SeedRouteRow
              key={s.id}
              seed={{
                id: s.id,
                origin: s.origin,
                originName: s.originName,
                destination: s.destination,
                destinationName: s.destinationName,
                active: s.active,
                lookAheadDays: s.lookAheadDays,
                scrapeInterval: s.scrapeInterval,
                cabinClass: s.cabinClass,
                preferredAirlines: s.preferredAirlines,
                snapshotCount: s._count.snapshots,
                runCount: s._count.fetchRuns,
                lastRunAt: s.fetchRuns[0]?.startedAt.toISOString() ?? null,
                lastRunStatus: s.fetchRuns[0]?.status ?? null,
                airlinesSeen: airlinesMap.get(s.id) ?? [],
                createdAt: s.createdAt.toISOString(),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
