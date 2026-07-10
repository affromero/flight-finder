export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { prisma } from '@/lib/prisma';
import { formatCurrency } from '@/lib/currency';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Footer } from '@/components/Footer';
import shell from '../page.module.css';
import styles from './page.module.css';

interface Props {
  params: Promise<{ route: string }>;
}

function parseRoute(slug: string): { origin: string; destination: string } | null {
  const match = slug.toUpperCase().match(/^([A-Z]{3})-([A-Z]{3})$/);
  if (!match) return null;
  const [, origin, destination] = match;
  if (!origin || !destination) return null;
  return { origin, destination };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { route } = await params;
  const parsed = parseRoute(route);
  if (!parsed) return { title: 'Route not found' };
  const title = `${parsed.origin} to ${parsed.destination} community prices`;
  const description = `Community-sourced flight price data for ${parsed.origin} to ${parsed.destination}.`;
  return {
    title,
    description,
    openGraph: { title, description },
  };
}

export default async function ExploreRoutePage({ params }: Props) {
  const { route } = await params;
  const parsed = parseRoute(route);
  if (!parsed) notFound();
  const { origin, destination } = parsed;

  const snapshots = await prisma.communitySnapshot.findMany({
    where: { origin, destination },
    orderBy: { scrapedAt: 'desc' },
    take: 200,
  });
  if (snapshots.length === 0) notFound();

  const prices = snapshots.map((s) => s.price);
  const min = Math.round(Math.min(...prices));
  const max = Math.round(Math.max(...prices));
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const airlines = Array.from(new Set(snapshots.map((s) => s.airline))).sort();
  const cabins = Array.from(new Set(snapshots.map((s) => s.cabinClass))).sort();
  const currencies = Array.from(new Set(snapshots.map((s) => s.currency))).sort();
  // Mixed-currency aggregates cannot carry one code; the data window line
  // below already discloses the mix, so fall back to a bare number there.
  const statCurrency = currencies.length === 1 ? currencies[0] : null;
  const stat = (v: number) =>
    statCurrency ? formatCurrency(v, statCurrency) : v.toLocaleString('en-US');
  const recent = snapshots.slice(0, 25);

  // snapshots.length > 0 was guarded above with notFound(), so these are defined.
  const oldest = snapshots[snapshots.length - 1]!;
  const newest = snapshots[0]!;
  const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  return (
    <main className={shell.root}>
      <div className={shell.topBar}>
        <ThemeToggle />
      </div>

      <div className={shell.hero}>
        <h1 className={shell.title}>
          <Link href="/">Flight Finder</Link>{' '}
          <span className={shell.titleAccent}>{origin} &rarr; {destination}</span>
        </h1>
        <p className={shell.tagline}>
          Community-sourced flight prices on this route
        </p>
        <p className={styles.crumb}>
          <Link href="/explore" className={styles.crumbLink}>&larr; all routes</Link>
        </p>
      </div>

      <div className={styles.statsGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>cheapest</span>
          <span className={styles.statValue}>{stat(min)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>average</span>
          <span className={styles.statValue}>{stat(avg)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>highest</span>
          <span className={styles.statValue}>{stat(max)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>data points</span>
          <span className={styles.statValue}>{snapshots.length}</span>
        </div>
      </div>

      <p className={styles.window}>
        Data window: {dateFmt.format(oldest.scrapedAt)} to {dateFmt.format(newest.scrapedAt)}
        {currencies.length === 1 ? ` (${currencies[0]})` : ` (mixed currencies: ${currencies.join(', ')})`}
      </p>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>airlines</h2>
        <div className={styles.chipRow}>
          {airlines.map((a) => (
            <span key={a} className={styles.chip}>{a}</span>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>cabin classes</h2>
        <div className={styles.chipRow}>
          {cabins.map((c) => (
            <span key={c} className={styles.chip}>{c}</span>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>recent snapshots</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>scraped</th>
                <th>travel date</th>
                <th>airline</th>
                <th>stops</th>
                <th>cabin</th>
                <th className={styles.priceCol}>price</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td>{dateFmt.format(s.scrapedAt)}</td>
                  <td>{dateFmt.format(s.travelDate)}</td>
                  <td>{s.airline}</td>
                  <td>{s.stops === 0 ? 'nonstop' : String(s.stops)}</td>
                  <td>{s.cabinClass}</td>
                  <td className={styles.priceCol}>{formatCurrency(s.price, s.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.cta}>
        <Link href={`/?prefill=${origin}+to+${destination}`} className={shell.emptyLink}>
          Track this route
        </Link>
      </div>

      <Footer />
    </main>
  );
}
