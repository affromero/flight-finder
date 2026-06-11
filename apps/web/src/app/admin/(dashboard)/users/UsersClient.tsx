'use client';

import { useEffect, useState } from 'react';
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
      body: JSON.stringify({ username: `guest${n}`, displayName: `Guest ${n}`, password: '', avatar }),
    });
    if (res.ok) await refresh();
    else alert((await res.json()).error || 'Failed to add guest');
  };

  const handleDelete = async (id: string, username: string) => {
    if (!confirm(`Delete user ${username}? Their trackers will become unowned.`)) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    if (res.ok) await refresh();
    else alert((await res.json()).error || 'Failed to delete user');
  };

  const handleResetPassword = async (id: string, username: string) => {
    const pw = prompt(`New password for ${username} (8+ chars):`);
    if (!pw) return;
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) alert('Password reset.');
    else alert((await res.json()).error || 'Failed to reset password');
  };

  const handleToggleAdmin = async (id: string, isAdmin: boolean) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: !isAdmin }),
    });
    if (res.ok) await refresh();
    else alert((await res.json()).error || 'Failed to update user');
  };

  const handleDisableMultiUser = async () => {
    if (
      !confirm(
        'Disable multi user mode? This turns off all logins and clears the admin password, reverting to a single user self hosted instance. Accounts stay in the database but become inaccessible until you re-enable multi user mode. Continue?',
      )
    )
      return;
    const res = await fetch('/api/admin/multi-user', { method: 'DELETE' });
    if (res.ok) {
      window.location.href = '/admin';
    } else {
      alert((await res.json()).error || 'Failed to disable multi user mode');
    }
  };

  return (
    <>
      {banner !== null && (
        <div className={styles.banner}>
          <p>
            {banner} existing tracker{banner === 1 ? '' : 's'} {banner === 1 ? 'was' : 'were'} assigned to you when you enabled multi user mode.
            Reassign any that belong to other household members from the{' '}
            <a href="/admin/queries">admin trackers page</a>.
          </p>
          <button className={styles.bannerDismiss} onClick={dismissBanner}>
            Dismiss
          </button>
        </div>
      )}

      <AddUserForm onCreated={refresh} />

      <button type="button" className={styles.action} onClick={handleQuickAddGuest}>
        + Add a guest (no password)
      </button>

      <div className={styles.list}>
        {users.length === 0 ? (
          <p className={styles.empty}>No users yet.</p>
        ) : (
          users.map((u) => (
            <div key={u.id} className={styles.row}>
              <div className={styles.rowUser}>
                <Avatar slug={u.avatar} name={u.displayName || u.username} size={36} />
                <div>
                  <div className={styles.rowName}>
                    {u.displayName || u.username}
                    {u.isAdmin && <span className={styles.adminBadge}>admin</span>}
                  </div>
                  <div className={styles.rowMeta}>
                    @{u.username} {' '} {u.queryCount} tracker{u.queryCount === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
              <div className={styles.rowActions}>
                <button className={styles.action} onClick={() => handleResetPassword(u.id, u.username)}>
                  Reset password
                </button>
                <button className={styles.action} onClick={() => handleToggleAdmin(u.id, u.isAdmin)}>
                  {u.isAdmin ? 'Demote' : 'Promote to admin'}
                </button>
                <button className={styles.danger} onClick={() => handleDelete(u.id, u.username)}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className={styles.addForm}>
        <h2 className={styles.formTitle}>Danger zone</h2>
        <p className={styles.rowMeta}>
          Turn off multi user mode and revert to a single user self hosted instance. Accounts are kept in the database but become inaccessible, and the admin password is cleared.
        </p>
        <button className={styles.danger} onClick={handleDisableMultiUser}>
          Disable multi user mode
        </button>
      </div>
    </>
  );
}

function AddUserForm({ onCreated }: { onCreated: () => Promise<void> }) {
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
      setError(data.error || 'Failed to create user');
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
      <h2 className={styles.formTitle}>Add user</h2>
      <div className={styles.formGrid}>
        <input
          className={styles.input}
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
          required
        />
        <input
          className={styles.input}
          placeholder="Display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="off"
        />
        <input
          className={styles.input}
          type="password"
          placeholder={isAdmin ? 'Password (8+ chars)' : 'Password (optional)'}
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
          Admin
        </label>
      </div>
      <AvatarPicker value={avatar} onChange={setAvatar} name={displayName || username} />
      <p className={styles.rowMeta}>
        Leave the password blank for a tap-to-sign-in member. Anyone who can reach this
        instance can sign in as a passwordless member, so add a password if it&apos;s public.
        Admins always need a password.
      </p>
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.primaryButton} disabled={submitting}>
        {submitting ? 'Adding...' : 'Add user'}
      </button>
    </form>
  );
}
