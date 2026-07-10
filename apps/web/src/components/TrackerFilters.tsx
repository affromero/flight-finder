'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDeleteToken } from '@/lib/tracker-storage';
import { MAX_PRICE_VALUE } from '@/lib/limits';
import styles from './TrackerFilters.module.css';

interface TrackerFilterState {
  maxPrice: number | null;
  maxStops: number | null;
  maxDurationHours: number | null;
  preferredAirlines: string[];
}

interface Props {
  queryId: string;
  filters: TrackerFilterState;
  canEdit?: boolean;
}

function countActiveFilters(filters: TrackerFilterState): number {
  return [
    filters.maxPrice !== null,
    filters.maxStops !== null,
    filters.maxDurationHours !== null,
    filters.preferredAirlines.length > 0,
  ].filter(Boolean).length;
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function TrackerFilters({ queryId, filters, canEdit = false }: Props) {
  const router = useRouter();
  const token = typeof window !== 'undefined' ? getDeleteToken(queryId) : null;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [maxPrice, setMaxPrice] = useState(filters.maxPrice?.toString() ?? '');
  const [maxStops, setMaxStops] = useState(filters.maxStops?.toString() ?? '');
  const [maxDurationHours, setMaxDurationHours] = useState(filters.maxDurationHours?.toString() ?? '');
  const [preferredAirlines, setPreferredAirlines] = useState(filters.preferredAirlines.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(() => countActiveFilters(filters), [filters]);

  const syncDraftFromFilters = useCallback(() => {
    setMaxPrice(filters.maxPrice?.toString() ?? '');
    setMaxStops(filters.maxStops?.toString() ?? '');
    setMaxDurationHours(filters.maxDurationHours?.toString() ?? '');
    setPreferredAirlines(filters.preferredAirlines.join(', '));
    setError(null);
  }, [filters.maxDurationHours, filters.maxPrice, filters.maxStops, filters.preferredAirlines]);

  const closePanel = useCallback(() => {
    syncDraftFromFilters();
    setOpen(false);
  }, [syncDraftFromFilters]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      closePanel();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [closePanel, open]);

  if (!token && !canEdit) return null;

  const openPanel = () => {
    syncDraftFromFilters();
    setOpen(true);
  };

  const togglePanel = () => {
    if (open) {
      closePanel();
      return;
    }
    openPanel();
  };

  const clearDraft = () => {
    setMaxPrice('');
    setMaxStops('');
    setMaxDurationHours('');
    setPreferredAirlines('');
    setError(null);
  };

  const save = async () => {
    setError(null);

    const nextMaxPrice = parseOptionalNumber(maxPrice);
    if (
      nextMaxPrice !== null &&
      (Number.isNaN(nextMaxPrice) || nextMaxPrice < 0 || nextMaxPrice > MAX_PRICE_VALUE)
    ) {
      setError('Max price cannot be negative.');
      return;
    }

    const nextMaxStops = parseOptionalNumber(maxStops);
    if (
      nextMaxStops !== null &&
      (Number.isNaN(nextMaxStops) || !Number.isInteger(nextMaxStops) || nextMaxStops < 0 || nextMaxStops > 10)
    ) {
      setError('Max stops must be a whole number from 0 to 10.');
      return;
    }

    const nextMaxDurationHours = parseOptionalNumber(maxDurationHours);
    if (
      nextMaxDurationHours !== null &&
      (
        Number.isNaN(nextMaxDurationHours) ||
        !Number.isInteger(nextMaxDurationHours) ||
        nextMaxDurationHours < 1 ||
        nextMaxDurationHours > 48
      )
    ) {
      setError('Max duration must be a whole number from 1 to 48.');
      return;
    }

    const airlines = preferredAirlines
      .split(',')
      .map((airline) => airline.trim())
      .filter(Boolean);

    setSaving(true);
    try {
      const res = await fetch(`/api/queries/${queryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deleteToken: token,
          maxPrice: nextMaxPrice,
          maxStops: nextMaxStops,
          maxDurationHours: nextMaxDurationHours,
          preferredAirlines: airlines,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || 'Could not update filters.');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        type="button"
        onClick={togglePanel}
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M2 4h12M4 8h8M6 12h4" />
        </svg>
        Filters
        {activeCount > 0 && <span className={styles.count}>{activeCount}</span>}
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.label}>Max stops</span>
              <input
                className={styles.input}
                type="number"
                min={0}
                max={10}
                step={1}
                placeholder="Any"
                value={maxStops}
                onChange={(event) => setMaxStops(event.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Max price</span>
              <input
                className={styles.input}
                type="number"
                min={0}
                step={1}
                placeholder="Any"
                value={maxPrice}
                onChange={(event) => setMaxPrice(event.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Max duration</span>
              <input
                className={styles.input}
                type="number"
                min={1}
                max={48}
                step={1}
                placeholder="Any"
                value={maxDurationHours}
                onChange={(event) => setMaxDurationHours(event.target.value)}
              />
            </label>

            <label className={`${styles.field} ${styles.airlines}`}>
              <span className={styles.label}>Airlines</span>
              <input
                className={styles.input}
                type="text"
                placeholder="Any airline"
                value={preferredAirlines}
                onChange={(event) => setPreferredAirlines(event.target.value)}
              />
            </label>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <button className={`${styles.secondary} ${styles.clear}`} type="button" onClick={clearDraft} disabled={saving}>
              Clear filters
            </button>
            <button className={styles.secondary} type="button" onClick={closePanel} disabled={saving}>
              Cancel
            </button>
            <button className={styles.primary} type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
