'use client';

import { useState } from 'react';
import { ALL_AGGREGATORS, AGGREGATOR_LABEL, EXPERIMENTAL_AGGREGATORS, type Aggregator } from '@/lib/aggregators';
import styles from './page.module.css';

interface Preferences {
  username: string;
  displayName: string | null;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  preferredAirlines: string[];
  preferredAggregators: string[];
  cabinClass: string | null;
}

const CABIN_CLASSES = ['economy', 'premium_economy', 'business', 'first'] as const;

// Build the initial render order: the user's saved order first, then any
// aggregators they have not explicitly placed (in the canonical order).
function buildInitialOrder(saved: string[]): Aggregator[] {
  const valid = saved.filter((s): s is Aggregator => (ALL_AGGREGATORS as readonly string[]).includes(s));
  const seen = new Set<Aggregator>(valid);
  const rest = ALL_AGGREGATORS.filter((a) => !seen.has(a));
  return [...valid, ...rest];
}

export function SettingsForm({
  initial,
  adminEnabledAggregators,
}: {
  initial: Preferences;
  adminEnabledAggregators: string[];
}) {
  const [displayName, setDisplayName] = useState(initial.displayName ?? '');
  const [defaultCurrency, setDefaultCurrency] = useState(initial.defaultCurrency ?? '');
  const [defaultCountry, setDefaultCountry] = useState(initial.defaultCountry ?? '');
  const [preferredAirlines, setPreferredAirlines] = useState(
    initial.preferredAirlines.join(', '),
  );
  const [cabinClass, setCabinClass] = useState(initial.cabinClass ?? '');
  const [aggregatorOrder, setAggregatorOrder] = useState<Aggregator[]>(
    () => buildInitialOrder(initial.preferredAggregators),
  );
  // Selection: which aggregators the user has explicitly chosen. Empty means
  // "inherit defaults" (server-side fallback to admin allowlist order).
  const [aggregatorSelection, setAggregatorSelection] = useState<Set<Aggregator>>(
    () => new Set(
      initial.preferredAggregators.filter((s): s is Aggregator => (ALL_AGGREGATORS as readonly string[]).includes(s))
    ),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const adminAllowed = new Set(adminEnabledAggregators);

  const moveAggregator = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= aggregatorOrder.length) return;
    const next = [...aggregatorOrder];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setAggregatorOrder(next);
  };

  const toggleAggregator = (source: Aggregator) => {
    const next = new Set(aggregatorSelection);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    setAggregatorSelection(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');

    const airlines = preferredAirlines
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Send the explicitly selected aggregators in the user's chosen order.
    // Empty selection persists as [] which the server reads as
    // "inherit admin defaults".
    const selectedAggregators = aggregatorOrder.filter((s) => aggregatorSelection.has(s));

    const res = await fetch('/api/account/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: displayName.trim() || null,
        defaultCurrency: defaultCurrency.trim().toUpperCase() || null,
        defaultCountry: defaultCountry.trim().toUpperCase() || null,
        preferredAirlines: airlines,
        preferredAggregators: selectedAggregators,
        cabinClass: cabinClass || null,
      }),
    });

    setSaving(false);
    const data = await res.json();
    if (data.ok) setMessage('Saved');
    else setError(data.error || 'Failed to save');
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label className={styles.label}>Username</label>
        <p className={styles.fixed}>@{initial.username}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          className={styles.input}
          placeholder="Optional"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="currency">Default currency</label>
        <input
          id="currency"
          className={styles.input}
          placeholder="USD, EUR, GBP..."
          maxLength={3}
          value={defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="country">Default country</label>
        <input
          id="country"
          className={styles.input}
          placeholder="US, DE, GB..."
          maxLength={2}
          value={defaultCountry}
          onChange={(e) => setDefaultCountry(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="airlines">Preferred airlines</label>
        <input
          id="airlines"
          className={styles.input}
          placeholder="Comma separated (Delta, Lufthansa, ...)"
          value={preferredAirlines}
          onChange={(e) => setPreferredAirlines(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="cabin">Cabin class</label>
        <select
          id="cabin"
          className={styles.input}
          value={cabinClass}
          onChange={(e) => setCabinClass(e.target.value)}
        >
          <option value="">Use instance default (economy)</option>
          {CABIN_CLASSES.map((c) => (
            <option key={c} value={c}>{c.replace('_', ' ')}</option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Aggregator preference</label>
        <div className={styles.aggregatorList}>
          {aggregatorOrder.map((source, index) => {
            const allowedByAdmin = adminAllowed.has(source);
            const experimental = EXPERIMENTAL_AGGREGATORS.has(source);
            const checked = aggregatorSelection.has(source);
            const disabled = !allowedByAdmin;
            return (
              <div
                key={source}
                className={styles.aggregatorRow}
                data-disabled={disabled ? 'true' : 'false'}
              >
                <span className={styles.aggregatorIndex}>{index + 1}.</span>
                <label className={styles.aggregatorToggle}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleAggregator(source)}
                  />
                </label>
                <span className={styles.aggregatorLabel}>{AGGREGATOR_LABEL[source]}</span>
                {experimental && <span className={styles.aggregatorTag}>experimental</span>}
                <div className={styles.aggregatorButtons}>
                  <button
                    type="button"
                    className={styles.aggregatorButton}
                    onClick={() => moveAggregator(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${AGGREGATOR_LABEL[source]} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.aggregatorButton}
                    onClick={() => moveAggregator(index, 1)}
                    disabled={index === aggregatorOrder.length - 1}
                    aria-label={`Move ${AGGREGATOR_LABEL[source]} down`}
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className={styles.aggregatorHint}>
          Order matters: when one source returns no flights, the next is tried.
          Leave everything unchecked to inherit instance defaults.
        </p>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {message && <p className={styles.success}>{message}</p>}

      <button type="submit" className={styles.button} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </form>
  );
}
