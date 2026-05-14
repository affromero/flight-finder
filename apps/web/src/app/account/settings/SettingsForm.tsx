'use client';

import { useState } from 'react';
import styles from './page.module.css';

interface Preferences {
  username: string;
  displayName: string | null;
  defaultCurrency: string | null;
  defaultCountry: string | null;
  preferredAirlines: string[];
  cabinClass: string | null;
}

const CABIN_CLASSES = ['economy', 'premium_economy', 'business', 'first'] as const;

export function SettingsForm({ initial }: { initial: Preferences }) {
  const [displayName, setDisplayName] = useState(initial.displayName ?? '');
  const [defaultCurrency, setDefaultCurrency] = useState(initial.defaultCurrency ?? '');
  const [defaultCountry, setDefaultCountry] = useState(initial.defaultCountry ?? '');
  const [preferredAirlines, setPreferredAirlines] = useState(
    initial.preferredAirlines.join(', '),
  );
  const [cabinClass, setCabinClass] = useState(initial.cabinClass ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');

    const airlines = preferredAirlines
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await fetch('/api/account/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: displayName.trim() || null,
        defaultCurrency: defaultCurrency.trim().toUpperCase() || null,
        defaultCountry: defaultCountry.trim().toUpperCase() || null,
        preferredAirlines: airlines,
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

      {error && <p className={styles.error}>{error}</p>}
      {message && <p className={styles.success}>{message}</p>}

      <button type="submit" className={styles.button} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </form>
  );
}
