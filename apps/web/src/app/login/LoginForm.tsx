'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/Avatar/Avatar';
import { sanitizeNext } from '@/lib/safe-next';
import styles from './page.module.css';

interface Profile {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  isAdmin: boolean;
}

interface LoginResponse {
  ok: boolean;
  data?: { user: { isAdmin: boolean } };
  error?: string;
}

export function LoginForm({ next }: { next: string | null }) {
  const t = useTranslations('Login');
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/profiles')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setProfiles(body?.data?.profiles ?? []))
      .catch(() => setProfiles([]));
  }, []);

  const selectProfile = async (username: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const body = (await response.json().catch(() => null)) as LoginResponse | null;
      if (!response.ok || !body?.data?.user) {
        setError(body?.error || t('invalidCredentials'));
        return;
      }
      window.location.href = sanitizeNext(next) ?? (body.data.user.isAdmin ? '/admin' : '/account');
    } catch {
      setError(t('invalidCredentials'));
    } finally {
      setLoading(false);
    }
  };

  if (profiles === null) {
    return <main className={styles.root}><p className={styles.loading}>{t('loading')}</p></main>;
  }

  return (
    <main className={styles.root}>
      <h1 className={styles.pickerTitle}>{loading ? t('signingIn') : t('pickerTitle')}</h1>
      {profiles.length === 0 ? <p className={styles.loading}>{t('noProfiles')}</p> : (
        <div className={styles.profiles}>
          {profiles.map((profile) => {
            const name = profile.displayName || profile.username;
            return (
              <button
                key={profile.id}
                type="button"
                className={styles.profile}
                disabled={loading}
                onClick={() => void selectProfile(profile.username)}
              >
                <Avatar slug={profile.avatar} name={name} size={104} />
                <span className={styles.profileName}>{name}</span>
                {profile.isAdmin && <span className={styles.profileRole}>Admin</span>}
              </button>
            );
          })}
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </main>
  );
}
