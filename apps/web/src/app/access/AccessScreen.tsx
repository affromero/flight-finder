'use client';

import { AccessForm, type AccessFormMode, type AccessFormCopy } from 'thesidedoor/react';
import { useTranslations } from 'next-intl';
import { sanitizeNext } from '@/lib/safe-next';
import styles from './page.module.css';

export function AccessScreen({ next, mode, hosted }: { next: string | null; mode: AccessFormMode; hosted: boolean }) {
  const t = useTranslations('SharedAccess');
  const errors: Record<string, string> = { unauthorized: t('unauthorized'), forbidden: t('forbidden'), conflict: t('conflict'), rate_limited: t('rate_limited'), cancelled: t('cancelled'), passkey_failed: t('passkey_failed'), ceremony_busy: t('ceremony_busy'), outcome_unknown: t('outcome_unknown'), network_error: t('network_error'), invalid_password: t('invalid_password') };
  const copy: AccessFormCopy = {
    login: t('login'), household: t('household'), claim: t('claim'), recover: t('recover'), name: t('name'), password: t('password'), code: t('code'), passkey: t('passkey'), savePasskey: t('savePasskey'), savePasskeyHint: t('savePasskeyHint'), continueWithoutPasskey: t('continueWithoutPasskey'), working: t('working'), newPasswordHint: t('newPasswordHint'), mode: t('mode'), householdMode: t('householdMode'), individualMode: t('individualMode'), passkeyUnavailable: t('passkeyUnavailable'), error: code => errors[code] ?? t('failed'),
  };
  return <main className={styles.root}>
    <div className={styles.content}>
      <p className={styles.brand}>Flight Finder</p>
      <h1 className={styles.title}>{t('title')}</h1>
      <AccessForm initialMode={mode} modes={hosted ? ['login', 'recover'] : ['household', 'claim', 'recover']} claimModes={['household']} copy={copy} classes={{ root: styles.access, form: styles.form, navigation: styles.navigation, label: styles.label, input: styles.input, button: styles.button, secondary: styles.secondary, error: styles.error, hint: styles.hint }} onSignedIn={session => {
        const destination = sanitizeNext(next);
        if (!session.principal) {
          window.location.assign(`/login${destination ? `?next=${encodeURIComponent(destination)}` : ''}`);
          return;
        }
        window.location.assign(destination ?? (session.principal.role === 'owner' ? '/admin' : '/account'));
      }} />
    </div>
  </main>;
}
