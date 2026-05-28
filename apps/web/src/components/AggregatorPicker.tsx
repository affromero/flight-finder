'use client';

import { useState } from 'react';
import { getDeleteToken } from '@/lib/tracker-storage';
import { ALL_AGGREGATORS, AGGREGATOR_LABEL, EXPERIMENTAL_AGGREGATORS, type Aggregator } from '@/lib/aggregators';
import styles from './AggregatorPicker.module.css';

interface Props {
  queryId: string;
  currentAggregators: string[];
  adminEnabledAggregators: string[];
  // Server-resolved: this viewer may edit even without a local delete token
  // (self-hosted solo, admin, or owner). See canManageQueryWithoutToken.
  canEdit?: boolean;
}

export function AggregatorPicker({ queryId, currentAggregators, adminEnabledAggregators, canEdit = false }: Props) {
  const [selected, setSelected] = useState<Set<Aggregator>>(
    () => new Set(
      currentAggregators.filter((s): s is Aggregator =>
        (ALL_AGGREGATORS as readonly string[]).includes(s),
      ),
    ),
  );
  const [saving, setSaving] = useState(false);

  const token = typeof window !== 'undefined' ? getDeleteToken(queryId) : null;

  if (!token && !canEdit) return null;

  const adminAllowed = new Set(adminEnabledAggregators);

  const toggle = async (source: Aggregator) => {
    if (!adminAllowed.has(source) || saving) return;

    const next = new Set(selected);
    if (next.has(source)) next.delete(source);
    else next.add(source);

    const ordered = ALL_AGGREGATORS.filter((a) => next.has(a));

    setSaving(true);
    try {
      const res = await fetch(`/api/queries/${queryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: token, preferredAggregators: ordered }),
      });
      const data = await res.json();
      if (data.ok) {
        setSelected(next);
      }
    } catch {
      // keep previous state
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.root}>
      <span className={styles.label}>Sources</span>
      <div className={styles.options}>
        {ALL_AGGREGATORS.map((source) => {
          const allowed = adminAllowed.has(source);
          const checked = selected.has(source);
          const experimental = EXPERIMENTAL_AGGREGATORS.has(source);
          return (
            <button
              key={source}
              className={`${styles.option} ${checked ? styles.active : ''} ${!allowed ? styles.disabled : ''}`}
              onClick={() => toggle(source)}
              disabled={!allowed || saving}
              title={!allowed ? 'Disabled by admin' : AGGREGATOR_LABEL[source]}
            >
              <span className={`${styles.check} ${checked ? styles.checked : ''}`}>
                {checked ? '✓' : ''}
              </span>
              {AGGREGATOR_LABEL[source]}
              {experimental && <span className={styles.experimental}>β</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
