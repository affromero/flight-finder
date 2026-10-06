'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getCountryProfile } from '@/lib/scraper/country-profiles';
import type { VpnProviderType } from '@/lib/scraper/vpn/types';
import styles from './VpnPreferences.module.css';

export interface VpnReadiness { provider: string; configured: boolean; sidecarRunning: boolean; ready: boolean; countries?: string[]; error?: string }
interface Preferences { vpnProvider: string | null; vpnCountries: string[]; updatedAt: string; providerRevision: number }
interface Props {
  provider: string;
  countries: string[];
  revision: Pick<Preferences, 'updatedAt' | 'providerRevision'>;
  onProviderChange: (provider: VpnProviderType) => void;
  onCountriesChange: (countries: string[]) => void;
  onSaved: (config: Preferences) => void;
  onStatus: (status: VpnReadiness) => void;
  status: VpnReadiness | null;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
}

export function VpnPreferences({ provider, countries, revision, onProviderChange, onCountriesChange, onSaved, onStatus, status, disabled, onBusyChange }: Props) {
  const t = useTranslations('Settings.vpn');
  const [text, setText] = useState(countries.join(', '));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function save() {
    if (busy || disabled) return;
    const selected = [...new Set(text.toUpperCase().split(/[,\s]+/).filter(Boolean))];
    if (selected.some(country => !/^[A-Z]{2}$/.test(country) || (provider === 'mullvad' && !getCountryProfile(country)))) {
      setMessage(t('invalidCountries')); return;
    }
    setBusy(true); onBusyChange(true); setMessage('');
    try {
      const response = await fetch('/api/admin/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vpnProvider: provider === 'none' ? null : provider, vpnCountries: selected,
          expectedUpdatedAt: revision.updatedAt, expectedRevision: revision.providerRevision }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw Error(data.error || t('saveFailed'));
      onCountriesChange(selected); onSaved(data.data);
      setText(selected.join(', '));
      try {
        const readiness = await fetch('/api/vpn/status', { cache: 'no-store' });
        const checked = await readiness.json();
        if (!readiness.ok || !checked.ok) throw Error(t('savedReadinessFailed'));
        onStatus(checked.data);
        setMessage(checked.data.error || checked.data.provider !== provider ? t('savedReadinessFailed') : t('configured'));
      } catch { setMessage(t('savedReadinessFailed')); }
    } catch (error) { setMessage(error instanceof Error ? error.message : t('saveFailed')); }
    finally { setBusy(false); onBusyChange(false); }
  }

  const current = status?.provider === provider ? status : null;
  return <div className={styles.root}>
    <label className={styles.field}>{t('providerLabel')}
      <select value={provider} disabled={busy || disabled} onChange={event => onProviderChange(event.target.value as VpnProviderType)}>
        <option value="none">{t('disabledOption')}</option><option value="expressvpn">ExpressVPN</option><option value="mullvad">Mullvad via Tailscale</option>
      </select>
    </label>
    <label className={styles.field}>{t('countriesLabel')}
      <input value={text} disabled={busy || disabled} placeholder="US, DE, GB" onChange={event => {
        setText(event.target.value);
        onCountriesChange([...new Set(event.target.value.toUpperCase().split(/[,\s]+/).filter(Boolean))]);
      }} />
    </label>
    <p className={styles.hint}>{t('countriesHint')}</p>
    {provider === 'mullvad' && <p className={styles.hint}>{t('mullvadSetup')} <a href="https://tailscale.com/docs/features/exit-nodes/mullvad-exit-nodes" target="_blank" rel="noopener noreferrer">{t('setupGuide')}</a></p>}
    {current && <p role="status">{provider === 'none' ? t('disabledOption') : current.ready ? t('statusReady') : t('statusSidecarOffline')}{current.countries && current.countries.length > 0 ? ': ' + current.countries.join(', ') : ''}</p>}
    <div className={styles.actions}><button type="button" disabled={busy || disabled} onClick={() => void save()}>{busy ? t('saving') : t('savePreferences')}</button>
      {message && <span role="status">{message}</span>}</div>
  </div>;
}
