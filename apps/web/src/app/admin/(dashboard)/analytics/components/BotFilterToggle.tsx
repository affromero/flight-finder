'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { BotFilter } from '@/lib/analytics/query';
import styles from './BotFilterToggle.module.css';

const OPTIONS: { labelKey: 'humans' | 'bots' | 'all'; value: BotFilter }[] = [
  { labelKey: 'humans', value: 'humans' },
  { labelKey: 'bots', value: 'bots' },
  { labelKey: 'all', value: 'all' },
];

export function BotFilterToggle({ current }: { current: BotFilter }) {
  const t = useTranslations('AdminAnalytics');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setFilter(value: BotFilter) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'humans') {
      params.delete('botFilter');
    } else {
      params.set('botFilter', value);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className={styles.toggle}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={`${styles.button} ${current === opt.value ? styles.active : ''}`}
          onClick={() => setFilter(opt.value)}
        >
          {t(`filter.${opt.labelKey}`)}
        </button>
      ))}
    </div>
  );
}
