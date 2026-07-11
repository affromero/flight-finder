'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import styles from './UsageStats.module.css';

interface Stats {
  activeQueries: number;
  totalScrapes: number;
  totalPricePoints: number;
  llmCost30d?: number; // only returned to authenticated admins; hidden otherwise
  cron: {
    intervalHours: number;
    nextScrape: string | null;
    lastScrape: string | null;
  };
}

function timeUntil(iso: string, t: ReturnType<typeof useTranslations>): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return t('now');
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return t('inMinutes', { minutes });
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? t('inHoursMinutes', { hours, minutes: remainMinutes }) : t('inHours', { hours });
}

export function UsageStats() {
  const t = useTranslations('UsageStats');
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch('/api/stats')
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) setStats(data.data);
      })
      .catch(() => {});
  }, []);

  if (!stats) return null;

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <span className={styles.value}>{stats.activeQueries}</span>
        <span className={styles.label}>{t('tracking')}</span>
      </div>
      <div className={styles.card}>
        <span className={styles.value}>{stats.totalScrapes}</span>
        <span className={styles.label}>{t('scrapes')}</span>
      </div>
      <div className={styles.card}>
        <span className={styles.value}>{stats.totalPricePoints.toLocaleString()}</span>
        <span className={styles.label}>{t('prices')}</span>
      </div>
      {stats.llmCost30d !== undefined && (
        <div className={styles.card}>
          <span className={styles.value}>${stats.llmCost30d}</span>
          <span className={styles.label}>{t('llmCost')}</span>
        </div>
      )}
      {stats.cron.nextScrape && (
        <span className={styles.cron}>
          {t('nextScrape', { time: timeUntil(stats.cron.nextScrape, t), hours: stats.cron.intervalHours })}
        </span>
      )}
    </div>
  );
}
