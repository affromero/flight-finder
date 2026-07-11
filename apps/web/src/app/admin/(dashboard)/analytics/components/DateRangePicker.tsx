'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import styles from './DateRangePicker.module.css';

interface Props {
  from: string;
  to: string;
}

export function DateRangePicker({ from, to }: Props) {
  const t = useTranslations('AdminAnalytics');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function update(newFrom: string, newTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', newFrom);
    params.set('to', newTo);
    router.push(`${pathname}?${params.toString()}`);
  }

  function setPreset(days: number) {
    const now = new Date();
    const newTo = now.toISOString().slice(0, 10);
    const newFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    update(newFrom, newTo);
  }

  function setSingleDay(daysAgo: number) {
    const target = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const date = target.toISOString().slice(0, 10);
    update(date, date);
  }

  return (
    <div className={styles.picker}>
      <div className={styles.presets}>
        <button className={styles.preset} onClick={() => setSingleDay(0)}>
          {t('dateRange.today')}
        </button>
        <button className={styles.preset} onClick={() => setSingleDay(1)}>
          {t('dateRange.yesterday')}
        </button>
        <button className={styles.preset} onClick={() => setPreset(7)}>
          {t('dateRange.last7d')}
        </button>
        <button className={styles.preset} onClick={() => setPreset(30)}>
          {t('dateRange.last30d')}
        </button>
        <button className={styles.preset} onClick={() => setPreset(90)}>
          {t('dateRange.last90d')}
        </button>
      </div>
      <div className={styles.inputs}>
        <input
          type="date"
          className={styles.dateInput}
          value={from}
          onChange={(e) => update(e.target.value, to)}
        />
        <span className={styles.separator}>&mdash;</span>
        <input
          type="date"
          className={styles.dateInput}
          value={to}
          onChange={(e) => update(from, e.target.value)}
        />
      </div>
    </div>
  );
}
