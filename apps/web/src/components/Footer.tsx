import Link from 'next/link';
import styles from './Footer.module.css';

export function Footer() {
  return (
    <footer className={styles.root}>
      <p className={styles.links}>
        <Link href="/">Flight Finder</Link>
        {' '}&mdash; your data, not theirs
        {' '}&middot;{' '}
        <Link href="/explore">Explore community data</Link>
        {' '}&middot;{' '}
        <a href="https://github.com/affromero/flight-finder" target="_blank" rel="noopener noreferrer">GitHub</a>
        {' '}&middot;{' '}
        <a href="https://ko-fi.com/afromero" target="_blank" rel="noopener noreferrer">Support on Ko-fi</a>
      </p>
    </footer>
  );
}
