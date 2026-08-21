import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { sanitizeNext } from '@/lib/safe-next';
import {
  GATE_COOKIE,
  createSessionToken,
  gateCookieOptions,
  gateEnabled,
  verifyInviteToken,
} from '@/lib/access/gate';
import { getTranslations } from 'next-intl/server';
import { GateForm } from './GateForm';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; next?: string }>;
}) {
  if (!gateEnabled()) notFound();

  const t = await getTranslations('Gate');
  const params = await searchParams;
  const destination = sanitizeNext(params.next) ?? '/';

  // An invite link (typically scanned as a QR code) is exchanged for a session
  // cookie the moment it lands, then the browser is sent to a clean URL. Leaving
  // the token in the address bar would park a working credential in history,
  // server logs, and the referrer of every outbound link.
  if (params.t && (await verifyInviteToken(params.t))) {
    const token = await createSessionToken();
    if (token) {
      (await cookies()).set(GATE_COOKIE, token, gateCookieOptions());
      redirect(destination);
    }
  }

  return (
    <main className={styles.root}>
      <section className={styles.card}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.subtitle}>{t('subtitle')}</p>
        <GateForm next={destination} />
      </section>
    </main>
  );
}
