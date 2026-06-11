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
      <span className={styles.mark} aria-hidden="true" />
      <span className={styles.word}>Flight Finder</span>
    </Link>
  );
}
