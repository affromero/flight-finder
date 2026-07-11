'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import styles from './UpdateBanner.module.css';

interface RenameAnnouncement {
  from: string;
  to: string;
  upgradeCommand: string;
}

function safeStorageGet(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage?.getItem?.(key) ?? null : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage?.setItem?.(key, value);
  } catch {
    // Ignore: privacy mode, full quota, or stubbed Storage all fall through.
  }
}

export function UpdateBanner() {
  const t = useTranslations('UpdateBanner');
  const [latest, setLatest] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameAnnouncement | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/version')
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) return;
        if (data.data.updateAvailable) setLatest(data.data.latest);
        if (data.data.renameAnnouncement) {
          const key = `ft-rename-banner-dismissed-${data.data.latest ?? data.data.renameAnnouncement.to}`;
          if (safeStorageGet(key)) return;
          setRename(data.data.renameAnnouncement);
        }
      })
      .catch(() => {});
  }, []);

  if (rename && !dismissed) {
    const key = `ft-rename-banner-dismissed-${latest ?? rename.to}`;
    return (
      <div className={`${styles.root} ${styles.rename}`}>
        <span className={styles.text}>
          {t.rich('renamed', { to: rename.to, strong: (chunks) => <strong>{chunks}</strong> })}
        </span>
        <code className={styles.cmd}>{rename.upgradeCommand}</code>
        <button
          type="button"
          className={styles.dismiss}
          aria-label={t('dismiss')}
          onClick={() => {
            safeStorageSet(key, '1');
            setDismissed(true);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  if (!latest) return null;

  return (
    <div className={styles.root}>
      <span className={styles.text}>
        {t.rich('updateAvailable', { version: latest, strong: (chunks) => <strong>{chunks}</strong> })}
      </span>
      <code className={styles.cmd}>flight-finder update</code>
    </div>
  );
}
