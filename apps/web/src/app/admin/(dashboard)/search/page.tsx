import { getTranslations } from 'next-intl/server';
import { SearchBar } from '@/components/SearchBar';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function AdminSearchPage() {
  const t = await getTranslations('AdminSearch');
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.subtitle}>
          {t.rich('subtitle', { code: (chunks) => <code className={styles.code}>{chunks}</code> })}
        </p>
      </div>

      <div className={styles.searchWrapper}>
        <SearchBar surface="admin" />
      </div>
    </div>
  );
}
