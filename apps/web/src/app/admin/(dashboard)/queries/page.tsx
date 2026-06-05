import { prisma } from '@/lib/prisma';
import { groupQueries } from '@/lib/query-grouping';
import { QueryGroupRow, type AdminQuery } from './QueryRow';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function QueriesPage() {
  const queries = await prisma.query.findMany({
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: {
      _count: { select: { snapshots: true, fetchRuns: true } },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true, error: true },
      },
    },
  });

  const adminRows: AdminQuery[] = queries.map((q) => ({
    id: q.id,
    origin: q.origin,
    originName: q.originName,
    destination: q.destination,
    destinationName: q.destinationName,
    dateFrom: q.dateFrom.toISOString(),
    dateTo: q.dateTo.toISOString(),
    groupId: q.groupId,
    active: q.active,
    expiresAt: q.expiresAt.toISOString(),
    scrapeInterval: q.scrapeInterval,
    label: q.label,
    preferredAggregators: q.preferredAggregators,
    snapshotCount: q._count.snapshots,
    runCount: q._count.fetchRuns,
    createdAt: q.createdAt.toISOString(),
    lastScrapedAt: q.fetchRuns[0]?.startedAt.toISOString() ?? null,
    scrapeStatus: q.fetchRuns[0]?.status ?? null,
    scrapeError: q.fetchRuns[0]?.error ?? null,
  }));

  const groups = groupQueries(adminRows);

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Tracked Queries</h1>

      {groups.length === 0 ? (
        <p className={styles.empty}>
          No queries yet. Go to the <a href="/">home page</a> to create one.
        </p>
      ) : (
        <div className={styles.list}>
          {groups.map((group) => (
            <QueryGroupRow key={group.primaryId} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
