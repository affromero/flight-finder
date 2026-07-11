'use client';

import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import type { HourlyHeatmapCell } from '@/lib/analytics/query';
import styles from './HourlyHeatmap.module.css';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function HourlyHeatmap({ data }: { data: HourlyHeatmapCell[] }) {
  const t = useTranslations('AdminAnalytics');
  const dayLabels = DAY_KEYS.map((key) => t(`heatmap.days.${key}`));
  const maxCount = Math.max(1, ...data.map((c) => c.count));

  const cellMap = new Map<string, number>();
  for (const cell of data) {
    cellMap.set(`${cell.day}-${cell.hour}`, cell.count);
  }

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('heatmap.title')}</h2>
      {data.length === 0 ? (
        <p className={styles.empty}>{t('heatmap.empty')}</p>
      ) : (
        <>
          <div className={styles.grid}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={`h-${h}`} className={styles.hourLabel}>
                {h % 3 === 0 ? h : ''}
              </div>
            ))}

            {dayLabels.map((label, day) => (
              <Fragment key={day}>
                <div className={styles.dayLabel}>{label}</div>
                {Array.from({ length: 24 }, (_, hour) => {
                  const count = cellMap.get(`${day}-${hour}`) || 0;
                  const opacity = count > 0 ? 0.15 + 0.85 * (count / maxCount) : 0.05;
                  return (
                    <div
                      key={`${day}-${hour}`}
                      className={styles.cell}
                      style={{ opacity }}
                      title={t('heatmap.cellTitle', { day: label, hour, count })}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
          <div className={styles.legend}>
            <span>{t('heatmap.less')}</span>
            <div className={styles.legendBar}>
              {[0.1, 0.3, 0.5, 0.7, 1.0].map((o) => (
                <div key={o} className={styles.legendCell} style={{ opacity: o }} />
              ))}
            </div>
            <span>{t('heatmap.more')}</span>
          </div>
        </>
      )}
    </div>
  );
}
