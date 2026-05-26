'use client';

import { useState, useEffect } from 'react';
import styles from './UpdateBanner.module.css';

export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && data.data.updateAvailable) {
          setLatest(data.data.latest);
        }
      })
      .catch(() => {});
  }, []);

  if (!latest) return null;

  return (
    <div className={styles.root}>
      <span className={styles.text}>
        Flight Finder <strong>v{latest}</strong> is available.
      </span>
      <code className={styles.cmd}>flight-finder update</code>
    </div>
  );
}
