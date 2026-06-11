'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Avatar } from '@/components/Avatar/Avatar';
import styles from './ProfileMenu.module.css';

interface ProfileMenuProps {
  user: {
    username: string;
    displayName: string | null;
    avatar: string | null;
    isAdmin?: boolean;
  };
}

/**
 * The logged-in user's avatar in the header, opening a menu to reach account
 * settings (where the avatar is changed), switch user, or log out. Single
 * session model, so "Switch user" logs out and returns to the login screen.
 */
export function ProfileMenu({ user }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = user.displayName || user.username;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = async (dest: string) => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = dest;
  };

  return (
    <div className={styles.root} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={name}
      >
        <Avatar slug={user.avatar} name={name} size={32} />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.header}>
            <Avatar slug={user.avatar} name={name} size={40} />
            <div className={styles.who}>
              <span className={styles.name}>{name}</span>
              <span className={styles.handle}>@{user.username}</span>
            </div>
          </div>
          <Link href="/account" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            Your trackers
          </Link>
          <Link href="/account/settings" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            Account &amp; appearance
          </Link>
          <Link href="/connect" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            Connect a device
          </Link>
          {user.isAdmin && (
            <>
              <div className={styles.divider} role="separator" />
              <Link href="/settings" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
                Instance settings
              </Link>
              <Link href="/admin/users" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
                Manage household
              </Link>
              <Link href="/admin" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
                Admin dashboard
              </Link>
            </>
          )}
          <div className={styles.divider} role="separator" />
          <button className={styles.item} role="menuitem" onClick={() => logout('/login')}>
            Switch user
          </button>
          <button className={`${styles.item} ${styles.danger}`} role="menuitem" onClick={() => logout('/')}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
