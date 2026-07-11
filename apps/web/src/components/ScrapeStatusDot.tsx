'use client';

import { useTranslations } from 'next-intl';
import type { ScrapeStatus } from '@/lib/scrape-status';
import { useHydrated } from '@/lib/use-hydrated';
import styles from './ScrapeStatusDot.module.css';

export interface ScrapeStatusDotProps {
  status: ScrapeStatus | null;
  error?: string | null;
  lastScrapedAt?: string | null;
}

type Translator = ReturnType<typeof useTranslations>;

function statusLabel(status: ScrapeStatus, t: Translator): string {
  switch (status) {
    case 'success': return t('success');
    case 'failed': return t('failed');
    case 'partial': return t('partial');
    case 'in_progress': return t('inProgress');
  }
}

function timeAgo(iso: string, t: Translator): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t('justNow');
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('daysAgo', { count: days });
}

export function ScrapeStatusDot({ status, error, lastScrapedAt }: ScrapeStatusDotProps): React.ReactElement | null {
  const t = useTranslations('ScrapeStatusDot');
  const hydrated = useHydrated();
  if (status === null) return null;

  const parts: string[] = [];
  parts.push(t('lastScrape', { status: statusLabel(status, t) }));
  if (error) parts.push(error);
  // timeAgo derives from Date.now(), so the server and client clocks differ.
  // Only include it after mount so the title/aria-label match during hydration.
  if (hydrated && lastScrapedAt) parts.push(timeAgo(lastScrapedAt, t));
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
