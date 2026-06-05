'use client';

import { useState, useEffect } from 'react';
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

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `in ${hours}h ${remainMinutes}m` : `in ${hours}h`;
}

export function UsageStats() {
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
        <span className={styles.label}>Tracking</span>
      </div>
      <div className={styles.card}>
        <span className={styles.value}>{stats.totalScrapes}</span>
        <span className={styles.label}>Scrapes</span>
      </div>
      <div className={styles.card}>
        <span className={styles.value}>{stats.totalPricePoints.toLocaleString()}</span>
        <span className={styles.label}>Prices</span>
      </div>
      {stats.llmCost30d !== undefined && (
        <div className={styles.card}>
          <span className={styles.value}>${stats.llmCost30d}</span>
          <span className={styles.label}>LLM cost (30d)</span>
        </div>
      )}
      {stats.cron.nextScrape && (
        <span className={styles.cron}>
          Next scrape {timeUntil(stats.cron.nextScrape)} (every {stats.cron.intervalHours}h)
        </span>
      )}
    </div>
  );
}
