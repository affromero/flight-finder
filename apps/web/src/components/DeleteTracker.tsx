'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { getDeleteToken, removeSavedTracker } from '@/lib/tracker-storage';
import styles from './DeleteTracker.module.css';

interface Props {
  queryId: string;
}

export function DeleteTracker({ queryId }: Props) {
  const t = useTranslations('DeleteTracker');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? getDeleteToken(queryId) : null;

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/queries/${queryId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: token }),
      });

      const data = await res.json();

      if (!data.ok) {
        setError(data.error || t('deleteFailed'));
        setDeleting(false);
        return;
      }

      removeSavedTracker(queryId);
      router.push('/');
    } catch {
      setError(t('networkError'));
      setDeleting(false);
    }
  };

  if (confirming) {
    return (
      <div className={styles.root}>
        <p className={styles.warning}>
          {t('warning')}
        </p>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button
            className={styles.cancel}
            onClick={() => { setConfirming(false); setError(null); }}
            disabled={deleting}
          >
            {t('cancel')}
          </button>
          <button
            className={styles.confirm}
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? t('deleting') : t('confirmDelete')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button className={styles.trigger} onClick={() => setConfirming(true)}>
      {t('stopTracking')}
    </button>
  );
}
