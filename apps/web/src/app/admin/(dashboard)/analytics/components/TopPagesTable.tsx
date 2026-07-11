import { getTranslations } from 'next-intl/server';
import type { TopPageEngagement } from '@/lib/analytics/query';
import styles from './TopPagesTable.module.css';

function formatDuration(ms: number | null): string {
  if (ms === null) return '\u2014';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatScroll(depth: number | null): string {
  if (depth === null) return '\u2014';
  return `${Math.round(depth * 100)}%`;
}

export async function TopPagesTable({ pages }: { pages: TopPageEngagement[] }) {
  const t = await getTranslations('AdminAnalytics');
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('topPages.title')}</h2>
      {pages.length === 0 ? (
        <p className={styles.empty}>{t('topPages.empty')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('topPages.page')}</th>
              <th>{t('topPages.views')}</th>
              <th>{t('topPages.visitors')}</th>
              <th>{t('topPages.avgDuration')}</th>
              <th>{t('topPages.avgScroll')}</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.path}>
                <td className={styles.path}>{page.path}</td>
                <td>{page.views.toLocaleString()}</td>
                <td>{page.visitors.toLocaleString()}</td>
                <td>{formatDuration(page.avgDuration)}</td>
                <td>{formatScroll(page.avgScroll)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
