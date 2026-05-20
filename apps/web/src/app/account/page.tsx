import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { groupQueries, type GroupableQuery } from '@/lib/query-grouping';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

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
    },
  });

  const groupable: GroupableQuery[] = queries.map((q) => ({
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
    createdAt: q.createdAt.toISOString(),
  }));

  const groups = groupQueries(groupable);

  const fmt = (iso: string) => iso.split('T')[0];

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{user.displayName || user.username}</h1>
          <p className={styles.subtitle}>@{user.username}</p>
        </div>
        <div className={styles.headerActions}>
          <Link href="/" className={styles.link}>Search</Link>
          <Link href="/account/settings" className={styles.link}>Settings</Link>
          {user.isAdmin && <Link href="/admin" className={styles.link}>Admin</Link>}
          <LogoutButton />
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
              return (
                <Link key={g.primaryId} href={`/q/${g.primaryId}`} className={styles.row}>
                  <div className={styles.rowRoute}>
                    <span className={styles.rowCode}>{g.origin}</span>
                    <span className={styles.rowArrow}>→</span>
                    <span className={styles.rowCode}>{g.destination}</span>
                    {extraDestinations > 0 && (
                      <span className={styles.rowMeta}>+ {extraDestinations} more</span>
                    )}
                  </div>
                  <div className={styles.rowMeta}>
                    {fmt(g.dateFrom)} {' '} {fmt(g.dateTo)} {' '} {g.snapshotCount} snapshots
                    {g.routeCount > 1 && ` · ${g.routeCount} charts`}
                    {!g.anyActive && <span className={styles.paused}>paused</span>}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function LogoutButton() {
  return (
    <form action="/api/auth/logout" method="POST">
      <button type="submit" className={styles.logout}>Logout</button>
    </form>
  );
}
