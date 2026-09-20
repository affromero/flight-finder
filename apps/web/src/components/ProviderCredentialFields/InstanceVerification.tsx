'use client';

import { AccessVerification } from 'thesidedoor/react';
import { useTranslations } from 'next-intl';
import styles from './ProviderCredentialFields.module.css';

export function InstanceVerification({ disabled, onBusyChange }: { disabled?: boolean; onBusyChange?(busy: boolean): void }) {
  const t = useTranslations('SharedSecurity');
  const access = useTranslations('SharedAccess');
  return <details className={styles.verification}>
    <summary>{t('verify')}</summary>
    <AccessVerification disabled={disabled} onBusyChange={onBusyChange} copy={{ title: t('verify'), password: t('currentPassword'), verifyPassword: t('verifyPassword'), verifyPasskey: t('verifyPasskey'), verified: t('verified'), working: access('working'), error: code => access.has(code) ? access(code) : access('failed') }} classes={{ form: styles.root, label: styles.label, input: styles.input, button: styles.button, secondary: styles.button, hint: styles.hint, error: styles.error }} />
  </details>;
}
