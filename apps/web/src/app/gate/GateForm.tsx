'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { sanitizeNext } from '@/lib/safe-next';
import styles from './page.module.css';

interface Props {
  next: string | null;
}

export function GateForm({ next }: Props) {
  const t = useTranslations('Gate');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // A full navigation, not a client route change: the gate cookie has to
        // be attached by the browser on the next request for the middleware to
        // let it through.
        window.location.href = sanitizeNext(next) ?? '/';
        return;
      }
      setError(res.status === 429 ? t('tooMany') : t('wrongPassword'));
    } catch {
      setError(t('failed'));
    }
    setLoading(false);
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.label} htmlFor="gate-password">
        {t('passwordLabel')}
      </label>
      <input
        id="gate-password"
        className={styles.input}
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={e => setPassword(e.target.value)}
        disabled={loading}
      />
      <button className={styles.button} type="submit" disabled={loading || !password}>
        {loading ? t('unlocking') : t('submit')}
      </button>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
