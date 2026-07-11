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
import type { CountryBreakdown } from '@/lib/analytics/query';
import styles from './ChartCard.module.css';

function countryFlag(code: string): string {
  if (code.length !== 2) return '';
  const offset = 0x1f1e6 - 65;
  return String.fromCodePoint(code.charCodeAt(0) + offset, code.charCodeAt(1) + offset);
}

function formatCountryLabel(code: string): string {
  return `${countryFlag(code)} ${code}`;
}

export function CountryChart({ data }: { data: CountryBreakdown[] }) {
  const t = useTranslations('AdminAnalytics');
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('countries.title')}</h2>
      <div className={styles.chartContainer}>
        {data.length === 0 ? (
          <p className={styles.empty}>{t('countries.empty')}</p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(300, data.length * 30)}>
            <BarChart data={data} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" stroke="var(--muted)" fontSize={12} />
              <YAxis
                type="category"
                dataKey="country"
                stroke="var(--muted)"
                fontSize={12}
                width={60}
                interval={0}
                tickFormatter={formatCountryLabel}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                }}
                formatter={(value) => [value ?? 0, t('countries.visits')]}
                labelFormatter={(label) => formatCountryLabel(String(label))}
              />
              <Bar dataKey="count" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
