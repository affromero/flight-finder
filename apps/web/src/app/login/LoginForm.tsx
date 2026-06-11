'use client';

import { useState, useEffect } from 'react';
import { Avatar } from '@/components/Avatar/Avatar';
import { sanitizeNext } from '@/lib/safe-next';
import styles from './page.module.css';

interface Props {
  next: string | null;
}

interface Profile {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  hasPassword: boolean;
}

interface LoginResponse {
  ok: boolean;
  data?: { user: { isAdmin: boolean } };
  error?: string;
}

export function LoginForm({ next }: Props) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null); // null = loading
  const [selected, setSelected] = useState<Profile | null>(null);
  const [manual, setManual] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/profiles')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProfiles(d?.data?.profiles ?? []))
      .catch(() => setProfiles([]));
  }, []);

  const submit = async (uname: string) => {
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password }),
    });
    const body = (await res.json().catch(() => null)) as LoginResponse | null;
    if (res.ok && body?.data?.user) {
      const dest = sanitizeNext(next) ?? (body.data.user.isAdmin ? '/admin' : '/account');
      window.location.href = dest;
      return;
    }
    setError(body?.error || 'Invalid username or password');
    setLoading(false);
  };

  // Manual username + password (fallback, or when there are no profiles yet).
  const showManual = manual || (profiles !== null && profiles.length === 0);

  if (profiles === null) {
    return (
      <main className={styles.root}>
        <p className={styles.loading}>Loading…</p>
      </main>
    );
  }

  if (showManual) {
    return (
      <main className={styles.root}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            submit(username.trim());
          }}
        >
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
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          {profiles.length > 0 && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setManual(false);
                setError('');
                setPassword('');
              }}
            >
              Back to profiles
            </button>
          )}
        </form>
      </main>
    );
  }

  // Password screen for a chosen profile.
  if (selected) {
    const name = selected.displayName || selected.username;
    return (
      <main className={styles.root}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            submit(selected.username);
          }}
        >
          <Avatar slug={selected.avatar} name={name} size={88} />
          <h1 className={styles.title}>{name}</h1>
          <input
            type="password"
            className={styles.input}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
          {error && <p className={styles.error}>{error}</p>}
          <button className={styles.button} type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setSelected(null);
              setError('');
              setPassword('');
            }}
          >
            Back
          </button>
        </form>
      </main>
    );
  }

  // Profile picker ("Who's using Flight Finder?").
  return (
    <main className={styles.root}>
      <h1 className={styles.pickerTitle}>
        {loading ? 'Signing in…' : "Who's using Flight Finder?"}
      </h1>
      <div className={styles.profiles}>
        {profiles.map((p) => {
          const name = p.displayName || p.username;
          return (
            <button
              key={p.id}
              type="button"
              className={styles.profile}
              disabled={loading}
              onClick={() => {
                setError('');
                // Passwordless members tap straight in; the rest get a password screen.
                if (p.hasPassword) setSelected(p);
                else submit(p.username);
              }}
            >
              <Avatar slug={p.avatar} name={name} size={104} />
              <span className={styles.profileName}>{name}</span>
            </button>
          );
        })}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <button
        type="button"
        className={styles.linkButton}
        disabled={loading}
        onClick={() => setManual(true)}
      >
        Sign in with a username instead
      </button>
    </main>
  );
}
