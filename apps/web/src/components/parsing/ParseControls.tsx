'use client';
import { useTranslations } from 'next-intl';
import styles from './ParseControls.module.css';

export function ParseControls({ background, busy, status, onChange, onCancel }: {
  background: boolean; busy: boolean; status: string | null;
  onChange: (value: boolean) => void; onCancel: () => void;
}) {
  const t = useTranslations('SearchBar');
  return <div className={styles.controls}>
    <label><input type="checkbox" checked={background} disabled={busy} onChange={event => onChange(event.target.checked)} /> {t('backgroundParse')}</label>
    {status && <span role="status">{t(status === 'queued' ? 'parseQueued' : 'parseRunning')}</span>}
    {busy && background && <button type="button" onClick={onCancel}>{t('cancelParse')}</button>}
  </div>;
}
