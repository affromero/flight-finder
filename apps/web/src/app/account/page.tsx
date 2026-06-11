import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { groupQueries, type GroupableQuery } from '@/lib/query-grouping';
import { aggregateScrapeStatus } from '@/lib/scrape-status';
import { ScrapeStatusDot } from '@/components/ScrapeStatusDot';
import { ForceScrapeButton } from '@/components/ForceScrapeButton';
import { Avatar } from '@/components/Avatar/Avatar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ProfileMenu } from '@/components/ProfileMenu/ProfileMenu';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

interface AccountQuery extends GroupableQuery {
  scrapeStatus: string | null;
  scrapeError: string | null;
}

export default async function AccountPage() {
  if (!(await isMultiUserEnabled())) notFound();

  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/account');

  const queries = await prisma.query.findMany({
    where: { userId: user.id, isSeed: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      origin: true,
      destination: true,
      originName: true,
      destinationName: true,
      dateFrom: true,
      dateTo: true,
      active: true,
      expiresAt: true,
      createdAt: true,
      groupId: true,
      scrapeInterval: true,
      _count: { select: { snapshots: true } },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true, error: true },
      },
    },
  });

  const groupable: AccountQuery[] = queries.map((q) => ({
    id: q.id,
    origin: q.origin,
    destination: q.destination,
    originName: q.originName,
    destinationName: q.destinationName,
    dateFrom: q.dateFrom.toISOString(),
    dateTo: q.dateTo.toISOString(),
    groupId: q.groupId,
    active: q.active,
    expiresAt: q.expiresAt.toISOString(),
    scrapeInterval: q.scrapeInterval,
    snapshotCount: q._count.snapshots,
    lastScrapedAt: q.fetchRuns[0]?.startedAt.toISOString() ?? null,
    scrapeStatus: q.fetchRuns[0]?.status ?? null,
    scrapeError: q.fetchRuns[0]?.error ?? null,
    createdAt: q.createdAt.toISOString(),
  }));

  const groups = groupQueries(groupable);

  const fmt = (iso: string) => iso.split('T')[0];

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <Link href="/account/settings" className={styles.avatarLink} title="Change avatar">
            <Avatar slug={user.avatar} name={user.displayName || user.username} size={48} />
          </Link>
          <div>
            <h1 className={styles.title}>{user.displayName || user.username}</h1>
            <p className={styles.subtitle}>@{user.username}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          <ThemeToggle />
          <ProfileMenu
            user={{
              username: user.username,
              displayName: user.displayName,
              avatar: user.avatar,
              isAdmin: user.isAdmin,
            }}
          />
        </div>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Your trackers</h2>
        {groups.length === 0 ? (
          <p className={styles.empty}>
            No trackers yet. <Link href="/">Search for a flight</Link> to get started.
          </p>
        ) : (
          <div className={styles.list}>
            {groups.map((g) => {
              const extraDestinations = g.destinations.length - 1;
              const aggregate = aggregateScrapeStatus(
                g.queries.map((q) => ({
                  status: q.scrapeStatus,
                  error: q.scrapeError,
                  startedAt: q.lastScrapedAt ?? null,
                })),
              );
              return (
                <div key={g.primaryId} className={styles.row}>
                  <Link href={`/q/${g.primaryId}`} className={styles.rowBody}>
                    <div className={styles.rowRoute}>
                      <span className={styles.rowCode}>{g.origin}</span>
                      <span className={styles.rowArrow}>→</span>
                      <span className={styles.rowCode}>{g.destination}</span>
                      {extraDestinations > 0 && (
                        <span className={styles.rowMeta}>+ {extraDestinations} more</span>
                      )}
                    </div>
                    <div className={styles.rowMeta}>
                      <ScrapeStatusDot
                        status={aggregate.status}
                        error={aggregate.error}
                        lastScrapedAt={aggregate.startedAt}
                      />
                      {fmt(g.dateFrom)} {' '} {fmt(g.dateTo)} {' '} {g.snapshotCount} snapshots
                      {g.routeCount > 1 && ` · ${g.routeCount} charts`}
                      {!g.anyActive && <span className={styles.paused}>paused</span>}
                    </div>
                  </Link>
                  {g.anyActive && !g.allExpired && (
                    <ForceScrapeButton
                      queryId={g.primaryId}
                      ariaLabel="Refresh prices now"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

