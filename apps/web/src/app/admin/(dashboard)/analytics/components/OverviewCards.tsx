import { getTranslations } from 'next-intl/server';
import type { TotalStats } from '@/lib/analytics/query';
import styles from './OverviewCards.module.css';

function formatDuration(ms: number | null): string {
  if (ms === null) return '\u2014';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export async function OverviewCards({ totals }: { totals: TotalStats }) {
  const t = await getTranslations('AdminAnalytics');
  const cards = [
    { label: t('overview.pageViews'), value: totals.totalViews.toLocaleString() },
    { label: t('overview.uniqueVisitors'), value: totals.uniqueVisitors.toLocaleString() },
    { label: t('overview.bounceRate'), value: `${totals.bounceRate}%` },
    { label: t('overview.avgDuration'), value: formatDuration(totals.avgDuration) },
  ];

  return (
    <div className={styles.grid}>
      {cards.map((card) => (
        <div key={card.label} className={styles.card}>
          <span className={styles.label}>{card.label}</span>
          <span className={styles.value}>{card.value}</span>
        </div>
      ))}
    </div>
  );
}
