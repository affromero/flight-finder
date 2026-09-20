'use client';

import { AccessInvitation } from 'thesidedoor/react';
import { useTranslations } from 'next-intl';
import { sanitizeNext } from '@/lib/safe-next';
import styles from './invitation.module.css';

export function InvitationScreen({ next }: { next: string }) {
  const t = useTranslations('AccessInvitation');
  const access = useTranslations('SharedAccess');
  return <main className={styles.root}><section className={styles.card}>
    <h1 className={styles.title}>{t('title')}</h1>
    <p className={styles.subtitle}>{t('subtitle')}</p>
    <AccessInvitation endpoint="/api/access" copy={{ title: t('invitation'), submit: t('invitation'), code: t('invitationCode'), individual: access('individualMode'), name: access('name'), password: access('password'), working: access('working'), hint: access('newPasswordHint'), error: code => code === 'outcome_unknown' ? access('outcome_unknown') : t('failed') }} classes={{ form: styles.form, label: styles.label, input: styles.input, button: styles.button, error: styles.error }} onSignedIn={() => window.location.assign(sanitizeNext(next) ?? '/')} />
    <a href={`/access?next=${encodeURIComponent(next)}`}>{access('login')}</a>
  </section></main>;
}
