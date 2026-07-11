'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { useTranslations } from 'next-intl';
import type { DeviceBreakdown } from '@/lib/analytics/query';
import styles from './ChartCard.module.css';

const COLORS = ['#60A5FA', '#F59E0B', '#10B981', '#8B5CF6'];

export function DevicesChart({ data }: { data: DeviceBreakdown[] }) {
  const t = useTranslations('AdminAnalytics');
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('devices.title')}</h2>
      <div className={styles.chartContainer}>
        {data.length === 0 ? (
          <p className={styles.empty}>{t('devices.empty')}</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data}
                dataKey="count"
                nameKey="device"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                }}
              />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
