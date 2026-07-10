'use client';

import { safeHttpUrl } from '@/lib/safe-url';
import { formatCurrency } from '@/lib/currency';
import styles from './PriceCalendar.module.css';

interface Snapshot {
  travelDate: string;
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  vpnCountry?: string | null;
}

interface Props {
  snapshots: Snapshot[];
  currency: string;
}

interface DayData {
  date: string;
  minPrice: number;
  airline: string;
  bookingUrl: string | null;
}

export function PriceCalendar({ snapshots, currency }: Props) {
  if (snapshots.length === 0) return null;

  // Group by travel date, keep cheapest per date
  const byDate = new Map<string, DayData>();
  for (const s of snapshots) {
    const date = s.travelDate.split('T')[0]!;
    const existing = byDate.get(date);
    if (!existing || s.price < existing.minPrice) {
      byDate.set(date, {
        date,
        minPrice: s.price,
        airline: s.airline,
        bookingUrl: s.bookingUrl,
      });
    }
  }

  const days = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 2) return null;

  const prices = days.map((d) => d.minPrice);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice || 1;

  const formatDay = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className={styles.root}>
      <h3 className={styles.title}>Cheapest by Date</h3>
      <div className={styles.grid}>
        {days.map((d) => {
          const intensity = 1 - (d.minPrice - minPrice) / range;
          const isMin = d.minPrice === minPrice;
          return (
            <a
              key={d.date}
              href={safeHttpUrl(d.bookingUrl) || undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={`${styles.cell} ${isMin ? styles.cellBest : ''}`}
              style={{ '--intensity': intensity } as React.CSSProperties}
              title={`${formatDay(d.date)}: ${formatCurrency(d.minPrice, currency)} (${d.airline})`}
            >
              <span className={styles.cellDate}>{formatDay(d.date)}</span>
              <span className={styles.cellPrice}>{formatCurrency(d.minPrice, currency)}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
