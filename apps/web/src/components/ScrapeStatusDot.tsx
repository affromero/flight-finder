'use client';

import type { ScrapeStatus } from '@/lib/scrape-status';
import { useHydrated } from '@/lib/use-hydrated';
import styles from './ScrapeStatusDot.module.css';

export interface ScrapeStatusDotProps {
  status: ScrapeStatus | null;
  error?: string | null;
  lastScrapedAt?: string | null;
}

function statusLabel(status: ScrapeStatus): string {
  switch (status) {
    case 'success': return 'success';
    case 'failed': return 'failed';
    case 'partial': return 'partial';
    case 'in_progress': return 'in progress';
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ScrapeStatusDot({ status, error, lastScrapedAt }: ScrapeStatusDotProps): React.ReactElement | null {
  const hydrated = useHydrated();
  if (status === null) return null;

  const parts: string[] = [];
  parts.push(`Last scrape: ${statusLabel(status)}`);
  if (error) parts.push(error);
  // timeAgo derives from Date.now(), so the server and client clocks differ.
  // Only include it after mount so the title/aria-label match during hydration.
  if (hydrated && lastScrapedAt) parts.push(timeAgo(lastScrapedAt));
  const label = parts.join('. ');

  return (
    <span
      className={`${styles.dot} ${styles[status]}`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}
