'use client';

import { AccessForm, type AccessFormMode, type AccessFormCopy } from 'thesidedoor/react';
import { useTranslations } from 'next-intl';
import { sanitizeNext } from '@/lib/safe-next';
import styles from './page.module.css';

export function AccessScreen({ next, mode }: { next: string | null; mode: AccessFormMode }) {
  const t = useTranslations('SharedAccess');
  const errors: Record<string, string> = { unauthorized: t('unauthorized'), forbidden: t('forbidden'), conflict: t('conflict'), rate_limited: t('rate_limited'), cancelled: t('cancelled'), ceremony_busy: t('ceremony_busy'), outcome_unknown: t('outcome_unknown'), network_error: t('network_error'), invalid_password: t('invalid_password') };
  const copy: AccessFormCopy = {
    login: t('login'), household: t('household'), claim: t('claim'), recover: t('recover'), name: t('name'), password: t('password'), code: t('code'), passkey: t('passkey'), working: t('working'), newPasswordHint: t('newPasswordHint'), mode: t('mode'), householdMode: t('householdMode'), individualMode: t('individualMode'), passkeyUnavailable: t('passkeyUnavailable'), error: code => errors[code] ?? t('failed'),
  };
  return <main className={styles.root}>
    <div className={styles.content}>
      <p className={styles.brand}>Flight Finder</p>
      <h1 className={styles.title}>{t('title')}</h1>
      <AccessForm initialMode={mode} copy={copy} classes={{ root: styles.access, form: styles.form, navigation: styles.navigation, label: styles.label, input: styles.input, button: styles.button, secondary: styles.secondary, error: styles.error, hint: styles.hint }} onSignedIn={session => {
        window.location.assign(sanitizeNext(next) ?? (session.principal?.role === 'owner' ? '/admin' : session.principal ? '/account' : '/'));
      }} />
    </div>
  </main>;
}
