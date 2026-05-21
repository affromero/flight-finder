'use client';

import { useState, type MouseEvent } from 'react';
import styles from './ForceScrapeButton.module.css';

export interface ForceScrapeResult {
  accepted: boolean;
  count?: number;
  error?: string;
}

export interface ForceScrapeButtonProps {
  queryId: string;
  deleteToken?: string | null;
  onScraped?: (result: ForceScrapeResult) => void;
  ariaLabel?: string;
}

export function ForceScrapeButton({
  queryId,
  deleteToken,
  onScraped,
  ariaLabel,
}: ForceScrapeButtonProps): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const handleClick = async (e: MouseEvent<HTMLButtonElement>) => {
    // Always run both: stopPropagation alone is fragile against anchor
    // navigation when the button sits inside a <Link> row.
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    setHint(null);
    try {
      const res = await fetch(`/api/queries/${queryId}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: deleteToken ?? null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        onScraped?.({ accepted: true, count: data.data?.count });
      } else if (res.status === 429) {
        const msg = data?.error ?? 'Try again in a minute.';
        setHint(msg);
        onScraped?.({ accepted: false, error: msg });
      } else {
        const msg = data?.error ?? `Refresh failed (${res.status})`;
        setHint(msg);
        onScraped?.({ accepted: false, error: msg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setHint(msg);
      onScraped?.({ accepted: false, error: msg });
    } finally {
      setPending(false);
      // Clear the hint after a few seconds so it doesn't linger forever.
      if (hint === null) setTimeout(() => setHint(null), 4000);
    }
  };

  const label = ariaLabel ?? 'Refresh now';

  return (
    <button
      type="button"
      className={`${styles.button} ${pending ? styles.pending : ''}`}
      onClick={handleClick}
      disabled={pending}
      title={hint ?? label}
      aria-label={label}
    >
      <svg
        className={`${styles.icon} ${pending ? styles.spinning : ''}`}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 12a9 9 0 0 1 15.5-6.4L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15.5 6.4L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </button>
  );
}
