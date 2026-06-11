import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { prisma } from '@/lib/prisma';
import { SettingsForm } from './SettingsForm';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  if (!(await isMultiUserEnabled())) notFound();

  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/account/settings');

  // Read admin's aggregator allowlist server-side. This page is a Server
  // Component with 'force-dynamic' so DB reads are cheap and avoid exposing
  // /api/admin/config (admin-only) to the non-admin user viewing this page.
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { aggregatorsEnabled: true },
  });
  const adminEnabledAggregators = config?.aggregatorsEnabled ?? ['google_flights', 'airline_direct'];

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <Link href="/account" className={styles.backLink}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Your account
        </Link>
        <h1 className={styles.title}>Account settings</h1>
      </header>

      <SettingsForm
        initial={{
          username: user.username,
          displayName: user.displayName,
          avatar: user.avatar,
          theme: user.theme,
          defaultCurrency: user.defaultCurrency,
          defaultCountry: user.defaultCountry,
          preferredAirlines: user.preferredAirlines,
          preferredAggregators: user.preferredAggregators,
          cabinClass: user.cabinClass,
        }}
        adminEnabledAggregators={adminEnabledAggregators}
      />
    </main>
  );
}
