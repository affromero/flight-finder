'use client';

import { useState } from 'react';
import styles from './page.module.css';
import { sanitizeNext } from '@/lib/safe-next';

interface Props {
  next: string | null;
}

interface LoginResponse {
  ok: boolean;
  data?: {
    user: {
      id: string;
      username: string;
      displayName: string | null;
      isAdmin: boolean;
    };
  };
  error?: string;
}

export function LoginForm({ next }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const body = (await res.json().catch(() => null)) as LoginResponse | null;

    if (res.ok && body?.data?.user) {
      // Re-validate 'next' on the client to guard against a tampered prop or
      // an unexpected DOM mutation. Only same-site relative paths are safe.
      const safeDest = sanitizeNext(next) ?? (body.data.user.isAdmin ? '/admin' : '/account');
      window.location.href = safeDest;
      return;
    }

    setError(body?.error || 'Invalid username or password');
    setLoading(false);
  };

  return (
    <main className={styles.root}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Flight Finder</h1>
        <input
          type="text"
          className={styles.input}
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
        <input
          type="password"
          className={styles.input}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error && <p className={styles.error}>{error}</p>}
        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
