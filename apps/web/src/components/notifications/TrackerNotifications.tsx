'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getDeleteToken } from '@/lib/tracker-storage';
import { useHydrated } from '@/lib/use-hydrated';
import styles from './TrackerNotifications.module.css';

interface Settings {
  mode: 'inherit' | 'selected';
  revision: number;
  channelIds: string[];
  channels: { id: string; label: string | null; type: string; enabled: boolean }[];
}

export function TrackerNotifications({ queryId, canEdit }: { queryId: string; canEdit: boolean }) {
  const t = useTranslations('TrackerNotifications');
  const hydrated = useHydrated();
  const token = hydrated ? getDeleteToken(queryId) : null;
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<Settings['mode']>('inherit');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback((next: Settings) => {
    setSettings(next); setMode(next.mode); setSelected(next.channelIds);
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError(null); setSettings(null);
    try {
      const response = await fetch(`/api/queries/${queryId}/notifications`, { headers: token ? { 'x-delete-token': token } : {}, cache: 'no-store', signal });
      const body = await response.json() as { ok: boolean; error?: string; data?: { settings?: Settings } };
      if (!response.ok || !body.ok || !body.data?.settings) throw new Error(body.error || t('loadFailed'));
      if (!signal?.aborted) accept(body.data.settings);
    } catch (error) {
      if (!signal?.aborted) setError(error instanceof Error ? error.message : t('loadFailed'));
    } finally { if (!signal?.aborted) setBusy(false); }
  }, [queryId, token, t, accept]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  if (!canEdit && !token) return null;

  const save = async () => {
    if (!settings) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/queries/${queryId}/notifications`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, channelIds: mode === 'selected' ? selected : [], revision: settings.revision, deleteToken: token }),
      });
      const body = await response.json() as { ok: boolean; error?: string; data?: { settings?: Settings } };
      if (!response.ok || !body.ok || !body.data?.settings) throw new Error(body.error || t('saveFailed'));
      accept(body.data.settings); setOpen(false);
    } catch (error) { setError(error instanceof Error ? error.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  return <div className={styles.root}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{t('notifications')}</button>
    {open && <section className={styles.panel} aria-label={t('recipients')}>
      {busy && <p role="status">{t('loading')}</p>}
      {error && <p role="alert">{error}</p>}
      {settings && <>
        <label>{t('recipients')}<select value={mode} disabled={busy} onChange={event => setMode(event.target.value === 'selected' ? 'selected' : 'inherit')}>
          <option value="inherit">{t('inherit')}</option><option value="selected">{t('selected')}</option>
        </select></label>
        {mode === 'selected' && <fieldset disabled={busy}>
          <legend>{t('channels')}</legend>
          {settings.channels.map(channel => <label key={channel.id}>
            <input type="checkbox" checked={selected.includes(channel.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, channel.id] : ids.filter(id => id !== channel.id))} />
            {channel.label || channel.type}{!channel.enabled && ` (${t('disabled')})`}
          </label>)}
          {!settings.channels.length && <p>{t('noChannels')}</p>}
          <p>{t('emptyMutes')}</p>
          {selected.some(id => !settings.channels.some(channel => channel.id === id)) && <>
            <p role="alert">{t('removedChannels')}</p>
            <button type="button" onClick={() => setSelected(ids => ids.filter(id => settings.channels.some(channel => channel.id === id)))}>{t('removeUnavailable')}</button>
          </>}
        </fieldset>}
        <p>{t('scope')}</p>
        <button type="button" disabled={busy} onClick={() => void save()}>{t('save')}</button>
      </>}
      <button type="button" disabled={busy} onClick={() => void load()}>{t('reload')}</button>
      <button type="button" onClick={() => setOpen(false)}>{t('cancel')}</button>
    </section>}
  </div>;
}
