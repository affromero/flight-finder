'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/Avatar/Avatar';
import { AvatarPicker } from '@/components/AvatarPicker/AvatarPicker';
import { FLIGHT_AVATARS } from '@/lib/avatars';
import styles from './page.module.css';

interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  isAdmin: boolean;
  createdAt: string;
  queryCount: number;
}

interface Props {
  initialUsers: UserRow[];
}

// "ft-" prefix kept across the Flight Finder rename so existing browsers preserve state.
const BACKFILL_BANNER_KEY = 'ft-backfill-banner-dismissed';
const BACKFILL_COUNT_KEY = 'ft-backfill-count';

export function UsersClient({ initialUsers }: Props) {
  const t = useTranslations('AdminUsers');
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [banner, setBanner] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const dismissed = window.localStorage.getItem(BACKFILL_BANNER_KEY);
    if (dismissed) return;
    const count = Number(window.localStorage.getItem(BACKFILL_COUNT_KEY) ?? '0');
    if (count > 0) setBanner(count);
  }, []);

  const dismissBanner = () => {
    window.localStorage.setItem(BACKFILL_BANNER_KEY, '1');
    setBanner(null);
  };

  const refresh = async () => {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (data.ok) {
      interface ApiUser {
        id: string;
        username: string;
        displayName: string | null;
        avatar: string | null;
        isAdmin: boolean;
        createdAt: string;
        _count: { queries: number };
      }
      setUsers(
        (data.data.users as ApiUser[]).map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatar: u.avatar,
          isAdmin: u.isAdmin,
          createdAt: u.createdAt,
          queryCount: u._count.queries,
        })),
      );
    }
  };

  // One-tap passwordless member with a generic name and an auto-assigned avatar.
  const handleQuickAddGuest = async () => {
    const taken = new Set(users.map((u) => u.username));
    let n = 1;
    while (taken.has(`guest${n}`)) n += 1;
    const avatar = FLIGHT_AVATARS[(users.length) % FLIGHT_AVATARS.length]!.slug;
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `guest${n}`, displayName: t('guestDisplayName', { n }), password: '', avatar }),
    });
    if (res.ok) await refresh();
    else alert((await res.json()).error || t('errors.addGuest'));
  };

  const handleDelete = async (id: string, username: string) => {
    if (!confirm(t('deleteConfirm', { username }))) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    if (res.ok) await refresh();
    else alert((await res.json()).error || t('errors.delete'));
  };

  const handleResetPassword = async (id: string, username: string) => {
    const pw = prompt(t('resetPrompt', { username }));
    if (!pw) return;
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) alert(t('passwordReset'));
    else alert((await res.json()).error || t('errors.resetPassword'));
  };

  const handleToggleAdmin = async (id: string, isAdmin: boolean) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: !isAdmin }),
    });
    if (res.ok) await refresh();
    else alert((await res.json()).error || t('errors.update'));
  };

  const handleDisableMultiUser = async () => {
    if (!confirm(t('disableConfirm'))) return;
    const res = await fetch('/api/admin/multi-user', { method: 'DELETE' });
    if (res.ok) {
      window.location.href = '/admin';
    } else {
      alert((await res.json()).error || t('errors.disableMultiUser'));
    }
  };

  return (
    <>
      {banner !== null && (
        <div className={styles.banner}>
          <p>
            {t.rich('banner', {
              count: banner,
              link: (chunks) => <a href="/admin/queries">{chunks}</a>,
            })}
          </p>
          <button className={styles.bannerDismiss} onClick={dismissBanner}>
            {t('dismiss')}
          </button>
        </div>
      )}

      <AddUserForm onCreated={refresh} />

      <button type="button" className={styles.action} onClick={handleQuickAddGuest}>
        {t('addGuest')}
      </button>

      <div className={styles.list}>
        {users.length === 0 ? (
          <p className={styles.empty}>{t('noUsers')}</p>
        ) : (
          users.map((u) => (
            <div key={u.id} className={styles.row}>
              <div className={styles.rowUser}>
                <Avatar slug={u.avatar} name={u.displayName || u.username} size={36} />
                <div>
                  <div className={styles.rowName}>
                    {u.displayName || u.username}
                    {u.isAdmin && <span className={styles.adminBadge}>{t('adminBadge')}</span>}
                  </div>
                  <div className={styles.rowMeta}>
                    @{u.username} {' '} {t('trackerCount', { count: u.queryCount })}
                  </div>
                </div>
              </div>
              <div className={styles.rowActions}>
                <button className={styles.action} onClick={() => handleResetPassword(u.id, u.username)}>
                  {t('resetPassword')}
                </button>
                <button className={styles.action} onClick={() => handleToggleAdmin(u.id, u.isAdmin)}>
                  {u.isAdmin ? t('demote') : t('promote')}
                </button>
                <button className={styles.danger} onClick={() => handleDelete(u.id, u.username)}>
                  {t('delete')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className={styles.addForm}>
        <h2 className={styles.formTitle}>{t('dangerZone')}</h2>
        <p className={styles.rowMeta}>
          {t('dangerText')}
        </p>
        <button className={styles.danger} onClick={handleDisableMultiUser}>
          {t('disableMultiUser')}
        </button>
      </div>
    </>
  );
}

function AddUserForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const t = useTranslations('AdminUsers');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.trim(),
        displayName: displayName.trim() || null,
        password,
        isAdmin,
        avatar,
      }),
    });

    setSubmitting(false);

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || t('errors.create'));
      return;
    }

    setUsername('');
    setDisplayName('');
    setPassword('');
    setIsAdmin(false);
    setAvatar(null);
    await onCreated();
  };

  return (
    <form className={styles.addForm} onSubmit={handleSubmit}>
      <h2 className={styles.formTitle}>{t('addUser.title')}</h2>
      <div className={styles.formGrid}>
        <input
          className={styles.input}
          placeholder={t('addUser.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
          required
        />
        <input
          className={styles.input}
          placeholder={t('addUser.displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="off"
        />
        <input
          className={styles.input}
          type="password"
          placeholder={isAdmin ? t('addUser.passwordAdmin') : t('addUser.passwordOptional')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={isAdmin ? 8 : undefined}
          required={isAdmin}
        />
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          {t('addUser.admin')}
        </label>
      </div>
      <AvatarPicker value={avatar} onChange={setAvatar} name={displayName || username} />
      <p className={styles.rowMeta}>
        {t('addUser.note')}
      </p>
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.primaryButton} disabled={submitting}>
        {submitting ? t('addUser.adding') : t('addUser.submit')}
      </button>
    </form>
  );
}
