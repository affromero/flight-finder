'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useTranslations } from 'next-intl';
import type { SessionDepthBucket } from '@/lib/analytics/query';
import styles from './ChartCard.module.css';

export function SessionDepthChart({ data }: { data: SessionDepthBucket[] }) {
  const t = useTranslations('AdminAnalytics');
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('sessionDepth.title')}</h2>
      <div className={styles.chartContainer}>
        {data.length === 0 ? (
          <p className={styles.empty}>{t('sessionDepth.empty')}</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="depth" stroke="var(--muted)" fontSize={12} />
              <YAxis stroke="var(--muted)" fontSize={12} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                }}
                labelFormatter={(label) =>
                  label === '1'
                    ? t('sessionDepth.pageSingular', { label: String(label) })
                    : t('sessionDepth.pagePlural', { label: String(label) })
                }
              />
              <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
