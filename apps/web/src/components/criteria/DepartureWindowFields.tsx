'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { isTimePreference, TIME_PREFERENCES, type TimePreference } from '@/lib/criteria/departure';
import styles from './DepartureWindowFields.module.css';

interface Props {
  timePreference: string;
  strictDepartureTime: boolean;
  onChange: (preference: TimePreference, strict: boolean) => void;
  disabled?: boolean;
}

export function DepartureWindowFields({ timePreference, strictDepartureTime, onChange, disabled = false }: Props) {
  const t = useTranslations('DepartureWindowFields');
  const id = useId();
  const preference = isTimePreference(timePreference) ? timePreference : 'any';
  return (
    <div className={styles.root}>
      <label className={styles.label} htmlFor={`${id}-window`}>{t('window')}</label>
      <select
        id={`${id}-window`}
        className={styles.select}
        value={preference}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          const next = event.target.value;
          if (isTimePreference(next)) onChange(next, next !== 'any' && strictDepartureTime);
        }}
      >
        {TIME_PREFERENCES.map((value) => <option key={value} value={value}>{t(value)}</option>)}
      </select>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={preference !== 'any' && strictDepartureTime}
          disabled={disabled || preference === 'any'}
          aria-describedby={`${id}-help`}
          onChange={(event) => onChange(preference, event.target.checked)}
        />
        {t('strict')}
      </label>
      <p className={styles.help} id={`${id}-help`}>{t('help')}</p>
    </div>
  );
}
