'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { getDeleteToken } from '@/lib/tracker-storage';
import { useHydrated } from '@/lib/use-hydrated';
import { parsePriceRules, type RuleInput } from '@/lib/notifications/rules/config';
import styles from './TrackerPriceRules.module.css';

interface Settings {
  revision: number;
  rules: RuleInput[];
  currency: string | null;
  fixedCurrency: string | null;
  flights: { id: string; label: string; currency: string; price: number }[];
}

interface Draft {
  key: string;
  id?: string;
  flightId: string | null;
  currency: string;
  targetPrice: string;
  dropAbs: string;
  dropPct: string;
  originalDropPct: number | null;
  percentageEdited: boolean;
  cooldownMinutes: string;
  enabled: boolean;
}

function draft(rule: RuleInput): Draft {
  return { ...rule, key: rule.id ?? crypto.randomUUID(), targetPrice: rule.targetPrice === null ? '' : String(rule.targetPrice),
    dropAbs: rule.dropAbs === null ? '' : String(rule.dropAbs), dropPct: rule.dropPct === null ? '' : String(Number((rule.dropPct * 100).toPrecision(12))),
    originalDropPct: rule.dropPct, percentageEdited: false, cooldownMinutes: String(rule.cooldownMinutes) };
}

const scopeValue = (flightId: string | null, currency: string) => flightId === null ? '' : JSON.stringify([flightId, currency]);
const amount = (value: string) => value.trim() === '' ? null : Number(value);

export function TrackerPriceRules({ queryId, canEdit }: { queryId: string; canEdit: boolean }) {
  const t = useTranslations('TrackerPriceRules');
  const hydrated = useHydrated(), token = hydrated ? getDeleteToken(queryId) : null;
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = useCallback((next: Settings) => { setSettings(next); setRules(next.rules.map(draft)); }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError(null); setSettings(null);
    try {
      const response = await fetch(`/api/queries/${queryId}/alerts`, { headers: token ? { 'x-delete-token': token } : {}, cache: 'no-store', signal });
      const body = await response.json() as { ok: boolean; error?: string; data?: { settings?: Settings } };
      if (!response.ok || !body.ok || !body.data?.settings) throw new Error(body.error || t('loadFailed'));
      if (!signal?.aborted) accept(body.data.settings);
    } catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : t('loadFailed')); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, [queryId, token, t, accept]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);
  if (!canEdit && !token) return null;

  const update = (key: string, changes: Partial<Draft>) => setRules(current => current.map(rule => rule.key === key ? { ...rule, ...changes } : rule));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || busy) return;
    let input: ReturnType<typeof parsePriceRules>;
    try {
      if (rules.some(rule => rule.cooldownMinutes.trim() === '')) throw new Error('Missing cooldown');
      input = parsePriceRules({ revision: settings.revision, rules: rules.map(rule => ({ ...(rule.id ? { id: rule.id } : {}),
        flightId: rule.flightId, currency: rule.currency, enabled: rule.enabled, targetPrice: amount(rule.targetPrice), dropAbs: amount(rule.dropAbs),
        dropPct: !rule.percentageEdited ? rule.originalDropPct : amount(rule.dropPct) === null ? null : Number(rule.dropPct) / 100,
        cooldownMinutes: Number(rule.cooldownMinutes) })) });
    } catch { setError(t('invalid')); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/queries/${queryId}/alerts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, deleteToken: token }) });
      const body = await response.json() as { ok: boolean; error?: string; data?: { settings?: Settings } };
      if (!response.ok || !body.ok || !body.data?.settings) throw new Error(body.error || t('saveFailed'));
      accept(body.data.settings); setOpen(false);
    } catch (error) { setError(error instanceof Error ? error.message : t('saveFailed')); }
    finally { setBusy(false); }
  };
  return <div className={styles.root}>
    <button type="button" disabled={busy} aria-expanded={open} onClick={() => { if (!open) setSettings(null); setOpen(!open); }}>{t('alerts')}</button>
    {open && <section className={styles.panel} aria-label={t('rules')}>
      {busy && <p role="status">{t('loading')}</p>}
      {error && <p role="alert">{error}</p>}
      {settings && <form onSubmit={event => void save(event)}>
        <p>{t('behavior')}</p>
        {!rules.length && <p>{t('empty')}</p>}
        {rules.map((rule, index) => {
          const choices = settings.flights.filter(flight => !settings.fixedCurrency || flight.currency === settings.fixedCurrency);
          const known = choices.some(flight => flight.id === rule.flightId && flight.currency === rule.currency);
          return <fieldset key={rule.key} disabled={busy}>
            <legend>{t('ruleNumber', { number: index + 1 })}</legend>
            <label><input type="checkbox" checked={rule.enabled} onChange={event => update(rule.key, { enabled: event.target.checked })} />{t('enabled')}</label>
            {settings.fixedCurrency && rule.currency !== settings.fixedCurrency && <>
              <p role="alert">{t('currencyChanged', { currency: settings.fixedCurrency })}</p>
              <button type="button" onClick={() => update(rule.key, { flightId: null, currency: settings.fixedCurrency!, targetPrice: '', dropAbs: '' })}>{t('useTrackerCurrency')}</button>
            </>}
            <label>{t('scope')}<select value={scopeValue(rule.flightId, rule.currency)} onChange={event => {
              if (!event.target.value) { update(rule.key, { flightId: null }); return; }
              const [flightId, currency] = JSON.parse(event.target.value) as [string, string];
              update(rule.key, { flightId, currency, ...(currency !== rule.currency ? { targetPrice: '', dropAbs: '' } : {}) });
            }}>
              <option value="">{t('tracker')}</option>
              {rule.flightId !== null && !known && <option value={scopeValue(rule.flightId, rule.currency)}>{t('previousFlight')} ({rule.currency})</option>}
              {choices.map(flight =>
                <option key={scopeValue(flight.id, flight.currency)} value={scopeValue(flight.id, flight.currency)}>{flight.label} ({flight.currency})</option>)}
            </select></label>
            <label>{t('currency')}<input value={rule.currency} required pattern="[A-Z]{3}" maxLength={3}
              readOnly={settings.fixedCurrency !== null || rule.flightId !== null} onChange={event => update(rule.key,
                { currency: event.target.value.toUpperCase(), targetPrice: '', dropAbs: '' })} /></label>
            <div className={styles.thresholds}>
              <label>{t('target')}<input type="number" min="0" max="1000000000000" step="any" value={rule.targetPrice} onChange={event => update(rule.key, { targetPrice: event.target.value })} /></label>
              <label>{t('absolute')}<input type="number" min="0" max="1000000000000" step="any" value={rule.dropAbs} onChange={event => update(rule.key, { dropAbs: event.target.value })} /></label>
              <label>{t('percentage')}<input type="number" min="0" max="100" step="any" value={rule.dropPct} onChange={event => update(rule.key, { dropPct: event.target.value, percentageEdited: true })} /></label>
              <label>{t('cooldown')}<input type="number" required min="0" max="10080" step="1" value={rule.cooldownMinutes} onChange={event => update(rule.key, { cooldownMinutes: event.target.value })} /></label>
            </div>
            <button type="button" onClick={() => setRules(current => current.filter(row => row.key !== rule.key))}>{t('remove')}</button>
          </fieldset>;
        })}
        <p>{t('thresholdHelp')}</p>
        <button type="button" disabled={busy || rules.length >= 20} onClick={() => setRules(current => [...current, draft({ flightId: null,
          currency: settings.fixedCurrency ?? settings.currency ?? '', targetPrice: null, dropAbs: null, dropPct: null, enabled: true, cooldownMinutes: 0 })])}>{t('add')}</button>
        <button type="submit" disabled={busy}>{t('save')}</button>
      </form>}
      <button type="button" disabled={busy} onClick={() => void load()}>{t('reload')}</button>
      <button type="button" disabled={busy} onClick={() => setOpen(false)}>{t('cancel')}</button>
    </section>}
  </div>;
}
