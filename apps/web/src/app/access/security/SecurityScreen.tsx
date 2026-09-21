'use client';

import { AccessSecurity, type AccessSecurityCopy } from 'thesidedoor/react';
import { useTranslations } from 'next-intl';
import styles from '../page.module.css';

export function SecurityScreen() {
  const t = useTranslations('SharedSecurity');
  const access = useTranslations('SharedAccess');
  const errors: Record<string, string> = {
    unauthorized: access('unauthorized'), forbidden: access('forbidden'),
    conflict: access('conflict'), rate_limited: access('rate_limited'),
    cancelled: access('cancelled'), ceremony_busy: access('ceremony_busy'),
    outcome_unknown: access('outcome_unknown'), network_error: access('network_error'),
    invalid_password: access('invalid_password'),
  };
  const copy: AccessSecurityCopy = {
    title: t('title'), verify: t('verify'), currentPassword: t('currentPassword'),
    verifyPassword: t('verifyPassword'), verifyPasskey: t('verifyPasskey'),
    passkeys: t('passkeys'), passkeyName: t('passkeyName'), addPasskey: t('addPasskey'),
    remove: t('remove'), removeHint: t('removeHint'), recovery: t('recovery'),
    generateCodes: t('generateCodes'), recoveryHint: t('recoveryHint'), hideCodes: t('hideCodes'),
    password: t('password'), changePassword: t('changePassword'), sessions: t('sessions'),
    thisSession: t('thisSession'), signOut: t('signOut'), empty: t('empty'),
    completed: t('completed'), refreshFailed: t('refreshFailed'),
    working: access('working'), signIn: access('login'), passkeyUnavailable: access('passkeyUnavailable'),
    error: code => errors[code] ?? access('failed'),
  };
  return <main className={styles.root}>
    <div className={styles.content}>
      <p className={styles.brand}>Flight Finder</p>
      <AccessSecurity copy={copy} classes={{ root: styles.access, form: styles.form, label: styles.label, input: styles.input, button: styles.button, secondary: styles.secondary, error: styles.error, hint: styles.hint }}
        onSignInRequired={() => window.location.assign('/access?next=%2Faccess%2Fsecurity')} />
    </div>
  </main>;
}
