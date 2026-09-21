'use client';

import { ProviderFields, type ProviderFieldsPatch, type ProviderFieldStatus } from 'thesidedoor/react';
import { providerDescriptors } from 'thesidedoor-core/ai/catalog';
import { useTranslations } from 'next-intl';
import styles from './ProviderCredentialFields.module.css';

export function ProviderCredentialFields({ provider, fields, patch, onChange, disabled, error, reset, onResetChange }: {
  provider: string; fields?: readonly ProviderFieldStatus[]; patch: ProviderFieldsPatch;
  onChange(patch: ProviderFieldsPatch): void; disabled?: boolean; error?: boolean;
  reset?: boolean; onResetChange?(reset: boolean): void;
}) {
  const t = useTranslations('SharedProviderFields');
  const descriptor = providerDescriptors().find(item => item.id === provider);
  if (!descriptor) return null;
  return <ProviderFields descriptor={descriptor} fields={fields} patch={patch} onChange={onChange} disabled={disabled} error={error} reset={reset} onResetChange={onResetChange}
    copy={{ stored: t('stored'), unset: t('unset'), unchanged: t('unchanged'), clear: t('clear'), unavailable: t('unavailable'), reset: t('reset'), endpointMismatch: t('endpointMismatch'), label: (id, fallback) => t.has(`fields.${id}`) ? t(`fields.${id}`) : fallback }}
    classes={{ root: styles.root, field: styles.field, label: styles.label, input: styles.input, hint: styles.hint, button: styles.button, error: styles.error }} />;
}
