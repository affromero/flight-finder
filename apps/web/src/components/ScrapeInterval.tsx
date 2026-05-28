'use client';

import { useState } from 'react';
import { getDeleteToken } from '@/lib/tracker-storage';
import styles from './ScrapeInterval.module.css';

const INTERVALS = [
  { value: 1, label: '1h' },
  { value: 3, label: '3h' },
  { value: 6, label: '6h' },
  { value: 12, label: '12h' },
  { value: 24, label: '24h' },
];

interface Props {
  queryId: string;
  currentInterval: number | null;
  // Server-resolved: this viewer may edit even without a local delete token
  // (self-hosted solo, admin, or owner). See canManageQueryWithoutToken.
  canEdit?: boolean;
}

export function ScrapeInterval({ queryId, currentInterval, canEdit = false }: Props) {
  const [interval, setInterval] = useState<number | null>(currentInterval);
  const [saving, setSaving] = useState(false);

  const token = typeof window !== 'undefined' ? getDeleteToken(queryId) : null;

  if (!token && !canEdit) return null;

  const handleChange = async (value: number | null) => {
    if (value === interval) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/queries/${queryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: token, scrapeInterval: value }),
      });

      const data = await res.json();
      if (data.ok) {
        setInterval(value);
      }
    } catch {
      // silently fail — interval stays unchanged
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.root}>
      <span className={styles.label}>Check every</span>
      <div className={styles.options}>
        <button
          className={`${styles.option} ${interval === null ? styles.active : ''}`}
          onClick={() => handleChange(null)}
          disabled={saving}
        >
          Auto
        </button>
        {INTERVALS.map((opt) => (
          <button
            key={opt.value}
            className={`${styles.option} ${opt.value === interval ? styles.active : ''}`}
            onClick={() => handleChange(opt.value)}
            disabled={saving}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
