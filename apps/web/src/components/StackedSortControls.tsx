'use client';

import { useMemo, useState, type ReactNode } from 'react';
import styles from './StackedSortControls.module.css';

export interface StackedItem {
  key: string;
  outboundDate: string;
  currentPrice: number | null;
  node: ReactNode;
}

type SortMode = 'date' | 'price';

function sortItems(items: StackedItem[], mode: SortMode): StackedItem[] {
  const next = [...items];
  if (mode === 'date') {
    next.sort((a, b) => {
      if (a.outboundDate !== b.outboundDate) {
        return a.outboundDate < b.outboundDate ? -1 : 1;
      }
      return a.key.localeCompare(b.key);
    });
    return next;
  }
  // mode === 'price'
  next.sort((a, b) => {
    const aNull = a.currentPrice === null;
    const bNull = b.currentPrice === null;
    if (aNull && bNull) {
      // Both unpriced — keep chronological order so the bottom of the list
      // stays predictable.
      return a.outboundDate < b.outboundDate ? -1 : a.outboundDate > b.outboundDate ? 1 : 0;
    }
    if (aNull) return 1;
    if (bNull) return -1;
    if (a.currentPrice !== b.currentPrice) {
      return (a.currentPrice ?? 0) - (b.currentPrice ?? 0);
    }
    return a.outboundDate < b.outboundDate ? -1 : a.outboundDate > b.outboundDate ? 1 : 0;
  });
  return next;
}

export function StackedSortControls({ items }: { items: StackedItem[] }) {
  const [mode, setMode] = useState<SortMode>('date');
  const ordered = useMemo(() => sortItems(items, mode), [items, mode]);
  const hiddenInPriceMode = mode === 'price'
    ? items.filter((i) => i.currentPrice === null).length
    : 0;

  return (
    <>
      <div className={styles.controls}>
        <label htmlFor="stack-sort" className={styles.label}>Sort</label>
        <select
          id="stack-sort"
          className={styles.select}
          value={mode}
          onChange={(e) => setMode(e.target.value as SortMode)}
        >
          <option value="date">By date</option>
          <option value="price">Lowest price first</option>
        </select>
      </div>
      {ordered.map((item) => (
        <div key={item.key}>{item.node}</div>
      ))}
      {hiddenInPriceMode > 0 && (
        <p className={styles.footnote}>
          {hiddenInPriceMode} route{hiddenInPriceMode === 1 ? '' : 's'} placed last — no current price yet.
        </p>
      )}
    </>
  );
}
