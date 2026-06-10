'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ProfileMenu } from '@/components/ProfileMenu/ProfileMenu';
import styles from './layout.module.css';

const ALL_NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard', selfHosted: true },
  { href: '/admin/search', label: 'Search', selfHosted: true },
  { href: '/admin/queries', label: 'Queries', selfHosted: true },
  { href: '/admin/seed-routes', label: 'Seed Routes', selfHosted: false },
  { href: '/admin/insights', label: 'Insights', selfHosted: true },
  { href: '/admin/analytics', label: 'Analytics', selfHosted: false },
  { href: '/admin/config', label: 'Config', selfHosted: true },
  { href: '/admin/notifications', label: 'Notifications', selfHosted: true },
];

const USERS_NAV_ITEM = { href: '/admin/users', label: 'Users' };

export function DashboardNav({
  isSelfHosted,
  multiUserEnabled = false,
  user = null,
  children,
}: {
  isSelfHosted: boolean;
  multiUserEnabled?: boolean;
  user?: { username: string; displayName: string | null; avatar: string | null } | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const baseItems = isSelfHosted
    ? ALL_NAV_ITEMS.filter((item) => item.selfHosted)
    : ALL_NAV_ITEMS;
  const navItems = multiUserEnabled ? [...baseItems, USERS_NAV_ITEM] : baseItems;

  const handleLogout = async () => {
    const url = multiUserEnabled ? '/api/auth/logout' : '/api/admin/auth/logout';
    await fetch(url, { method: 'POST' });
    window.location.href = multiUserEnabled ? '/login' : '/admin/login';
  };

  const showLogout = !isSelfHosted || multiUserEnabled;

  return (
    <div className={styles.root}>
      <nav className={styles.nav}>
        <Link href="/" className={styles.brand}>Flight Finder</Link>
        <div className={styles.links}>
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${pathname === item.href ? styles.active : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <ThemeToggle />
        {user ? (
          <ProfileMenu user={user} />
        ) : (
          showLogout && (
            <button className={styles.logout} onClick={handleLogout}>
              Logout
            </button>
          )
        )}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
