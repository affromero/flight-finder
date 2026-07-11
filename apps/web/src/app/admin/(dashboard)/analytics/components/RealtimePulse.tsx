'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import styles from './RealtimePulse.module.css';

export function RealtimePulse({ initial }: { initial: number }) {
  const t = useTranslations('AdminAnalytics');
  const [count, setCount] = useState(initial);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/analytics/query?metric=realtime');
        if (res.ok) {
          const data = await res.json();
          setCount(data.data.activeVisitors);
        }
      } catch {
        // Will retry next interval
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className={styles.pulse}>
      <span className={styles.dot} />
      <span className={styles.text}>
        {t.rich('realtime', { count, strong: (chunks) => <strong>{chunks}</strong> })}
      </span>
    </div>
  );
}
