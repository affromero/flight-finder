'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ProfileMenu } from '@/components/ProfileMenu/ProfileMenu';
import styles from './layout.module.css';

const ALL_NAV_ITEMS = [
  { href: '/admin', labelKey: 'dashboard', selfHosted: true },
  { href: '/admin/search', labelKey: 'search', selfHosted: true },
  { href: '/admin/queries', labelKey: 'queries', selfHosted: true },
  { href: '/admin/seed-routes', labelKey: 'seedRoutes', selfHosted: false },
  { href: '/admin/insights', labelKey: 'insights', selfHosted: true },
  { href: '/admin/analytics', labelKey: 'analytics', selfHosted: false },
  { href: '/admin/config', labelKey: 'config', selfHosted: true },
  { href: '/admin/notifications', labelKey: 'notifications', selfHosted: true },
] as const;

const USERS_NAV_ITEM = { href: '/admin/users', labelKey: 'users' } as const;

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
  const t = useTranslations('AdminNav');
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
        <Link href="/" className={styles.brand}>{t('brand')}</Link>
        <div className={styles.links}>
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${pathname === item.href ? styles.active : ''}`}
            >
              {t(item.labelKey)}
            </Link>
          ))}
        </div>
        <ThemeToggle />
        {user ? (
          <ProfileMenu user={user} />
        ) : (
          showLogout && (
            <button className={styles.logout} onClick={handleLogout}>
              {t('logout')}
            </button>
          )
        )}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
