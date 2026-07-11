import { getTranslations } from 'next-intl/server';
import type { EntryExitPage } from '@/lib/analytics/query';
import styles from './EntryExitTable.module.css';

interface Props {
  entryPages: EntryExitPage[];
  exitPages: EntryExitPage[];
}

interface PageTableLabels {
  empty: string;
  page: string;
  sessions: string;
}

function PageTable({ title, pages, labels }: { title: string; pages: EntryExitPage[]; labels: PageTableLabels }) {
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {pages.length === 0 ? (
        <p className={styles.empty}>{labels.empty}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{labels.page}</th>
              <th>{labels.sessions}</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.path}>
                <td className={styles.path}>{page.path}</td>
                <td>{page.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export async function EntryExitTable({ entryPages, exitPages }: Props) {
  const t = await getTranslations('AdminAnalytics');
  const labels: PageTableLabels = {
    empty: t('entryExit.empty'),
    page: t('entryExit.page'),
    sessions: t('entryExit.sessions'),
  };
  return (
    <div className={styles.container}>
      <PageTable title={t('entryExit.entryTitle')} pages={entryPages} labels={labels} />
      <PageTable title={t('entryExit.exitTitle')} pages={exitPages} labels={labels} />
    </div>
  );
}
