import { getTranslations } from 'next-intl/server';
import type { ReferrerLandingPage } from '@/lib/analytics/query';
import styles from './ReferrerLandingTable.module.css';

export async function ReferrerLandingTable({ data }: { data: ReferrerLandingPage[] }) {
  const t = await getTranslations('AdminAnalytics');
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{t('referrerLanding.title')}</h2>
      {data.length === 0 ? (
        <p className={styles.empty}>{t('referrerLanding.empty')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('referrerLanding.domain')}</th>
              <th>{t('referrerLanding.landingPage')}</th>
              <th>{t('referrerLanding.count')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={`${row.domain}-${row.path}`}>
                <td className={styles.domain}>{row.domain}</td>
                <td className={styles.path}>{row.path}</td>
                <td>{row.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
