import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/user-auth';
import { Avatar } from '@/components/Avatar/Avatar';
import { CopyButton } from './CopyButton';
import { ShareButtons } from './ShareButtons';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

// "Connect from your phone" is a self-hosted concept (reach your own instance);
// hide it on the hosted deployment.
async function resolveInstanceUrl(): Promise<string> {
  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { publicBaseUrl: true },
  });
  const configured = config?.publicBaseUrl || process.env.APP_URL;
  if (configured) return configured.replace(/\/+$/, '');

  // No configured public URL: fall back to the origin the visitor reached this
  // page on, honoring the reverse proxy's forwarded headers.
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3003';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function ConnectPage() {
  if (process.env.SELF_HOSTED !== 'true') notFound();

  const t = await getTranslations('Connect');

  const url = await resolveInstanceUrl();
  const user = await getCurrentUser();
  const isSecure = url.startsWith('https://');
  // High error correction so the avatar badge in the center stays scannable.
  const qrSvg = await QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'H',
    color: { dark: '#031820', light: '#faf6ed' },
  });

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.subtitle}>
          {t('subtitle')}
        </p>
      </header>

      <section className={styles.urlCard}>
        <span className={styles.urlLabel}>{t('yourInstance')}</span>
        <div className={styles.urlRow}>
          <code className={styles.url}>{url}</code>
          <CopyButton value={url} />
        </div>
      </section>

      {!isSecure && (
        <div className={styles.warn}>
          <p className={styles.warnText}>
            {t.rich('insecureWarning', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <Link href="/settings#reach" className={styles.warnAction}>
            {t('setupSecureAccess')}
          </Link>
        </div>
      )}

      <section className={styles.qrCard}>
        {/* Server-rendered QR of the instance URL; encodes our own trusted value. */}
        <div className={styles.qrWrap}>
          <div className={styles.qr} dangerouslySetInnerHTML={{ __html: qrSvg }} />
          {user?.avatar && (
            <span className={styles.qrLogo}>
              <Avatar slug={user.avatar} name={user.displayName || user.username} size={46} />
            </span>
          )}
        </div>
        <p className={styles.qrHint}>{t('qrHint')}</p>
        <ShareButtons url={url} />
      </section>

      <section className={styles.steps}>
        <div className={styles.step}>
          <h2 className={styles.stepTitle}>{t('iosTitle')}</h2>
          <ol>
            <li>{t('iosStep1')}</li>
            <li>{t('iosStep2')}</li>
            <li>{t.rich('iosStep3', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
          </ol>
        </div>
        <div className={styles.step}>
          <h2 className={styles.stepTitle}>{t('androidTitle')}</h2>
          <ol>
            <li>{t('androidStep1')}</li>
            <li>{t('androidStep2')}</li>
            <li>{t.rich('androidStep3', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
          </ol>
        </div>
      </section>

      <p className={styles.desktopNote}>
        {t.rich('desktopNote', {
          link: (chunks) => <a href="/download">{chunks}</a>,
        })}
      </p>
    </main>
  );
}
