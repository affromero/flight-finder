'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './HomeBrand.module.css';

/**
 * Persistent "go home" wordmark pinned to the top-left of every page, so a user
 * is never stranded without a way back to the search/landing page.
 *
 * Hidden where a home affordance already exists or doesn't apply: the admin
 * dashboard has its own brand in the nav, and the setup wizard / login picker
 * are pre-home entry flows with nowhere to go "back" to yet.
 */
export function HomeBrand() {
  const pathname = usePathname();
  if (
    pathname?.startsWith('/admin') ||
    pathname?.startsWith('/setup') ||
    pathname?.startsWith('/login')
  ) {
    return null;
  }

  return (
    <Link href="/" className={styles.root} aria-label="Flight Finder home">
      <svg width="16" height="16" viewBox="95 2 58 58" fill="currentColor" aria-hidden="true">
        <path d="m103.3 13.4 3.6-3.1 24.3 5 8.3-9.2c1.7-1.8 5-2.4 7.5-2.8-0.2 2.6-0.4 5.8-2 7.7l-8.4 9.9 5 22.8-3.3 4.6-10.5-19.3-10.4 10.4 2 8.5-3.7 4.7-4.5-12.3-12.3-4.2 3.3-3.1 10 1.4 10-10.3z" />
      </svg>
      <span className={styles.word}>Flight Finder</span>
    </Link>
  );
}
