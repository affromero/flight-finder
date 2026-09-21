'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CliCatalog, ReasoningSelection } from '@/lib/scraper/cli-model-types';
import styles from './CliModelPicker.module.css';

interface Props {
  provider: string;
  model: string;
  reasoning: ReasoningSelection;
  onModelChange: (model: string) => void;
  onReasoningChange: (reasoning: ReasoningSelection) => void;
  setup?: boolean;
}
export function CliModelPicker({ provider, model, reasoning, onModelChange, onReasoningChange, setup = false }: Props) {
  const t = useTranslations('CliModels'), id = useId();
  const [catalog, setCatalog] = useState<CliCatalog | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [revision, setRevision] = useState(0), [testing, setTesting] = useState(false), [result, setResult] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{ targetVersion: string; managedUpdate: boolean } | null>(null);
  const [updating, setUpdating] = useState(false), [confirmUpdate, setConfirmUpdate] = useState(false), [updateResult, setUpdateResult] = useState('');
  const testController = useRef<AbortController | null>(null);
  const endpoint = setup ? '/api/setup/cli-models' : '/api/admin/cli-models';
  useEffect(() => {
    setUpdateInfo(null); setConfirmUpdate(false); setUpdateResult('');
    if (setup) return;
    const controller = new AbortController();
    fetch(`/api/admin/cli-models/update?provider=${provider}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const body = await response.json(); if (response.ok && body.ok && !controller.signal.aborted) setUpdateInfo(body.data); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [provider, setup]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setLoading(true); setError(''); setCatalog(null);
    fetch(`${endpoint}?provider=${provider}&refresh=${revision > 0}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || 'CLI discovery failed');
        if (!disposed) setCatalog(body.data as CliCatalog);
      }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'CLI discovery failed'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [endpoint, provider, revision]);
  useEffect(() => { setResult(''); return () => { testController.current?.abort(); }; }, [provider, model, reasoning]);
  const selected = catalog?.models.find(entry => entry.id === model);
  const unavailable = Boolean(catalog && !selected);
  async function update() {
    setUpdating(true); setConfirmUpdate(false); setUpdateResult('');
    try {
      const response = await fetch('/api/admin/cli-models/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || t('updateUnknown'));
      setUpdateResult(t('updateComplete', { version: body.data.version }));
      setRevision(value => value + 1);
    } catch (cause) { setUpdateResult(cause instanceof Error ? cause.message : t('updateUnknown')); }
    finally { setUpdating(false); }
  }
  async function test() {
    const controller = new AbortController(); testController.current = controller;
    setTesting(true); setResult('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ provider, model, reasoningEffort: reasoning }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || 'CLI test failed');
      if (!controller.signal.aborted) setResult(t('testPassed', { seconds: (body.data.durationMs / 1000).toFixed(1) }));
    } catch (cause) { if (!controller.signal.aborted) setResult(cause instanceof Error ? cause.message : t('testFailed')); }
    finally { if (testController.current === controller) { setTesting(false); testController.current = null; } }
  }
  return <section className={styles.root} aria-label={t('title')}>
    <div className={styles.header}><div><h3>{t('title')}</h3><p>{catalog ? t('version', { version: catalog.version }) : t('connectionHint')}</p></div>
      <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading || testing || updating}>{t('recheck')}</button></div>
    {updateInfo && <div className={styles.actions}>
      {updateInfo.managedUpdate ? <button type="button" disabled={updating || testing || catalog?.version === updateInfo.targetVersion} onClick={() => setConfirmUpdate(true)}>
        {updating ? t('updating') : catalog?.version === updateInfo.targetVersion ? t('upToDate') : t('update', { version: updateInfo.targetVersion })}
      </button> : <p className={styles.hint}>{t('manualUpdate')} <code>npm install -g {provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'}@{updateInfo.targetVersion}</code></p>}
    </div>}
    {confirmUpdate && <div className={styles.result}><p>{t('updateHint')}</p><div className={styles.actions}>
      <button type="button" onClick={() => void update()}>{t('confirmUpdate')}</button><button type="button" onClick={() => setConfirmUpdate(false)}>{t('keepVersion')}</button>
    </div></div>}
    {updateResult && <p role="status" className={styles.result}>{updateResult}</p>}
    {loading && <p role="status">{t('loading')}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.fields}>
      <div className={styles.field}><label htmlFor={`${id}-model`}>{t('model')}</label><select id={`${id}-model`} value={model} disabled={loading || testing || !catalog}
        onChange={event => { onModelChange(event.target.value); onReasoningChange(null); }}>
        {!selected && <option value={model}>{model || t('chooseModel')}{model ? ` — ${t('savedSelection')}` : ''}</option>}
        {catalog?.models.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></div>
      {provider === 'codex' && <div className={styles.field}><label htmlFor={`${id}-reasoning`}>{t('reasoning')}</label><select id={`${id}-reasoning`} value={reasoning ?? ''} disabled={loading || testing || !catalog || unavailable}
        onChange={event => onReasoningChange((event.target.value || null) as ReasoningSelection)}>
        <option value="">{t('cliConfigured')}</option>
        <option value="default">{selected?.defaultReasoningEffort ? t('modelDefault', { effort: selected.defaultReasoningEffort }) : t('default')}</option>
        {reasoning && reasoning !== 'default' && !selected?.reasoningEfforts.includes(reasoning) && <option value={reasoning}>{reasoning} — {t('savedSelection')}</option>}
        {selected?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{t(`efforts.${effort}`)}</option>)}
      </select></div>}
    </div>
    {unavailable && <p role="alert" className={styles.error}>{t('unavailable')}</p>}
    <p className={styles.hint}>{t(catalog?.source === 'live' ? 'liveCatalog' : 'configuredHint')}</p>
    <div className={styles.actions}><button type="button" disabled={loading || testing || updating || !catalog || unavailable || !model} onClick={() => void test()}>{testing ? t('testing') : t('test')}</button>
      {testing && <button type="button" onClick={() => { testController.current?.abort(); setResult(t('cancelled')); }}>{t('cancel')}</button>}
      <span className={styles.hint}>{t('testHint')}</span></div>
    {result && <p role="status" className={styles.result}>{result}</p>}
  </section>;
}
