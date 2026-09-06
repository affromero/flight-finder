'use client';
import { useTranslations } from 'next-intl';
import type { HotelTrackingOptions } from '@/lib/hotels/types';
import styles from './Hotels.module.css';
export const defaultHotelOptions: HotelTrackingOptions = { mode: 'best', targetPrice: null, notifyLows: true, allowApproximateAlerts: false, scrapeInterval: 3 };
export function HotelOptions({ value, onChange, edit = false }: { value: HotelTrackingOptions; onChange: (value: HotelTrackingOptions) => void; edit?: boolean }) {
  const t = useTranslations('Hotels');
  return <fieldset><legend>{t('tracking')}</legend><div className={styles.grid}>
    {!edit && <label className={styles.field}>{t('matchMode')}<select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as HotelTrackingOptions['mode'] })}><option value="best">{t('best')}</option><option value="room">{t('room')}</option></select></label>}
    <label className={styles.field}>{t('target')}<input type="number" min="0.01" step="0.01" value={value.targetPrice ?? ''} onChange={(e) => onChange({ ...value, targetPrice: e.target.value ? Number(e.target.value) : null })} /></label>
    <label className={styles.field}>{t('interval')}<input required type="number" min="1" max="24" value={value.scrapeInterval} onChange={(e) => onChange({ ...value, scrapeInterval: Number(e.target.value) })} /></label>
  </div><div className={styles.checks}><label className={styles.check}><input type="checkbox" checked={value.notifyLows} onChange={(e) => onChange({ ...value, notifyLows: e.target.checked })} />{t('notifyLows')}</label><label className={styles.check}><input type="checkbox" checked={value.allowApproximateAlerts} onChange={(e) => onChange({ ...value, allowApproximateAlerts: e.target.checked })} />{t('approximateAlerts')}</label></div><p className={styles.muted}>{t('targetHelp')}</p></fieldset>;
}
