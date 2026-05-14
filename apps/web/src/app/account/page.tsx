import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
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
      _count: { select: { snapshots: true } },
    },
  });

  const fmt = (d: Date) => d.toISOString().split('T')[0];

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
        {queries.length === 0 ? (
          <p className={styles.empty}>
            No trackers yet. <Link href="/">Search for a flight</Link> to get started.
          </p>
        ) : (
          <div className={styles.list}>
            {queries.map((q) => (
              <Link key={q.id} href={`/q/${q.id}`} className={styles.row}>
                <div className={styles.rowRoute}>
                  <span className={styles.rowCode}>{q.origin}</span>
                  <span className={styles.rowArrow}>→</span>
                  <span className={styles.rowCode}>{q.destination}</span>
                </div>
                <div className={styles.rowMeta}>
                  {fmt(q.dateFrom)} {' '} {fmt(q.dateTo)} {' '} {q._count.snapshots} snapshots
                  {!q.active && <span className={styles.paused}>paused</span>}
                </div>
              </Link>
            ))}
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
