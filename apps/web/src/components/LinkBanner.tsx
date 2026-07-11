'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import styles from './LinkBanner.module.css';

export interface CreatedTracker {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  date?: string;
}

interface LinkBannerProps {
  trackers: CreatedTracker[];
  onDismiss: () => void;
}

export function LinkBanner({ trackers, onDismiss }: LinkBannerProps) {
  const t = useTranslations('LinkBanner');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // For single tracker, link directly; for multiple, link to first (they share groupId)
  const primaryUrl = `${baseUrl}/q/${trackers[0]?.id}`;

  const handleCopy = async (index: number) => {
    const url = `${baseUrl}/q/${trackers[index]!.id}`;
    await navigator.clipboard.writeText(url);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleCopyAll = async () => {
    const urls = trackers.map((t) => `${baseUrl}/q/${t.id}`).join('\n');
    await navigator.clipboard.writeText(urls);
    setCopiedIndex(-1);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const isSingle = trackers.length === 1;

  return (
    <div className={styles.backdrop} onClick={onDismiss}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.success}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className={styles.checkIcon}>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t('trackersCreated', { count: trackers.length })}</span>
        </div>

        {trackers.map((tracker, i) => (
          <div key={tracker.id} className={styles.trackerRow}>
            <div className={styles.route}>
              <div className={styles.airport}>
                <span className={styles.code}>{tracker.origin}</span>
                <span className={styles.city}>{tracker.originName}</span>
              </div>
              <span className={styles.arrow}>→</span>
              <div className={styles.airport}>
                <span className={styles.code}>{tracker.destination}</span>
                <span className={styles.city}>{tracker.destinationName}</span>
              </div>
              {tracker.date && (
                <span className={styles.city}>
                  · {new Date(tracker.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              )}
            </div>

            <div className={styles.urlBox}>
              <div className={styles.urlRow}>
                <input
                  className={styles.urlInput}
                  value={`${baseUrl}/q/${tracker.id}`}
                  readOnly
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button className={styles.copyButton} onClick={() => handleCopy(i)}>
                  {copiedIndex === i ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                      {t('copied')}
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                      {t('copy')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}

        <div className={styles.warning}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.warningIcon}>
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <p className={styles.warningBold}>{t('saveWarning', { count: trackers.length })}</p>
            <p className={styles.warningText}>{t('deleteWarning', { count: trackers.length })}</p>
          </div>
        </div>

        <div className={styles.actions}>
          {!isSingle && (
            <button className={styles.goButton} onClick={handleCopyAll}>
              {copiedIndex === -1 ? t('copiedAll') : t('copyAllLinks')}
            </button>
          )}
          <a href={primaryUrl} className={styles.goButton}>
            {t('goToTracker')}
          </a>
          <button className={styles.dismissButton} onClick={onDismiss}>
            {t('done')}
          </button>
        </div>
      </div>
    </div>
  );
}
