'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import styles from './page.module.css';

export function LoginForm() {
  const t = useTranslations('AdminLogin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      window.location.href = '/admin';
    } else {
      setError(t('invalidPassword'));
      setLoading(false);
    }
  };

  return (
    <main className={styles.root}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>{t('title')}</h1>
        <input
          type="password"
          className={styles.input}
          placeholder={t('passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <p className={styles.error}>{error}</p>}
        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? t('signingIn') : t('signIn')}
        </button>
      </form>
    </main>
  );
}
