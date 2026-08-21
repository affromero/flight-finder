'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import styles from './page.module.css';

interface InviteResponse {
  ok: boolean;
  data?: { url: string };
  error?: string;
}

/**
 * Issues an access-gate invite and renders it as a QR code, so someone can be
 * let into a private instance by pointing a phone at the screen instead of
 * being told a shared password out loud.
 *
 * The QR is fetched as an SVG from the server rather than rendered client-side:
 * the `qrcode` package is already a server dependency, and this keeps the token
 * out of the client bundle's control flow.
 */
export function GateInvite() {
  const t = useTranslations('AdminUsers');
  const [invite, setInvite] = useState<{ url: string; qr: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const mint = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/gate-invite', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as InviteResponse | null;
      if (!res.ok || !body?.data?.url) {
        setError(body?.error ?? t('inviteFailed'));
        setLoading(false);
        return;
      }
      const qrRes = await fetch(`/api/admin/gate-invite/qr?url=${encodeURIComponent(body.data.url)}`);
      setInvite({ url: body.data.url, qr: qrRes.ok ? await qrRes.text() : '' });
    } catch {
      setError(t('inviteFailed'));
    }
    setLoading(false);
  };

  const copy = async () => {
    if (!invite) return;
    await navigator.clipboard.writeText(invite.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className={styles.inviteCard}>
      <h2 className={styles.inviteTitle}>{t('inviteTitle')}</h2>
      <p className={styles.inviteHint}>{t('inviteHint')}</p>

      <button className={styles.inviteButton} onClick={() => void mint()} disabled={loading}>
        {loading ? t('inviteWorking') : t('inviteAction')}
      </button>

      {error && (
        <p className={styles.inviteError} role="alert">
          {error}
        </p>
      )}

      {invite && (
        <div className={styles.inviteResult}>
          {invite.qr && (
            <div
              className={styles.inviteQr}
              // Server-generated SVG from the `qrcode` package, not user input.
              dangerouslySetInnerHTML={{ __html: invite.qr }}
            />
          )}
          <code className={styles.inviteUrl}>{invite.url}</code>
          <button className={styles.inviteCopy} onClick={() => void copy()}>
            {copied ? t('inviteCopied') : t('inviteCopy')}
          </button>
        </div>
      )}
    </section>
  );
}
