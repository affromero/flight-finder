import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import styles from './Footer.module.css';

export async function Footer() {
  const t = await getTranslations('Footer');
  return (
    <footer className={styles.root}>
      <p className={styles.links}>
        <Link href="/">Flight Finder</Link>
        {' '}&mdash; {t('tagline')}
        {' '}&middot;{' '}
        <Link href="/explore">{t('explore')}</Link>
        {' '}&middot;{' '}
        <a href="https://github.com/affromero/flight-finder" target="_blank" rel="noopener noreferrer">GitHub</a>
        {' '}&middot;{' '}
        <a href="https://ko-fi.com/afromero" target="_blank" rel="noopener noreferrer">{t('support')}</a>
      </p>
    </footer>
  );
}
