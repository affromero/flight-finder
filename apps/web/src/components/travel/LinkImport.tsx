'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ImportKind } from '@/lib/travel/import-url';
import type { TravelImportDraft } from '@/lib/travel/import-draft';
import { travelRequest } from './client';
import styles from './LinkImport.module.css';

const examples: Record<ImportKind, { provider: string; url: string }[]> = {
  flights: [{ provider: 'Google Flights', url: 'https://www.google.com/travel/flights/booking?tfs=…' }],
  hotels: [
    { provider: 'Google Hotels', url: 'https://www.google.com/travel/hotels/entity/…' },
    { provider: 'Booking.com', url: 'https://www.booking.com/hotel/es/….html?checkin=…&checkout=…' },
  ],
  cars: [
    { provider: 'DiscoverCars', url: 'https://www.discovercars.com/offer/…?sq=…' },
    { provider: 'Auto Europe', url: 'https://book.autoeurope.com/en-us/options?rate_reference=…&…' },
  ],
};

export function LinkImport({ kind, disabled, value, onImport, onClear, onBusy }: { kind: ImportKind; disabled: boolean; value?: string; onImport: (draft: TravelImportDraft) => void; onClear: () => void; onBusy?: (busy: boolean) => void }) {
  const t = useTranslations('LinkImport');
  const helpId = useId(), examplesId = useId();
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; onBusy?.(false); }, [onBusy]);
  async function load() {
    if (disabled || busy) return;
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    setBusy(true); onBusy?.(true); setError('');
    try {
      const result = await travelRequest<TravelImportDraft>('/api/travel/import', { method: 'POST', body: JSON.stringify({ kind, url }), signal: controller.signal });
      if (!controller.signal.aborted) onImport(result);
    } catch (error) { if (request.current === controller) setError(controller.signal.aborted ? t('failed') : error instanceof Error ? error.message : t('failed')); }
    finally { clearTimeout(timer); if (request.current === controller) { setBusy(false); onBusy?.(false); request.current = null; } }
  }
  return <section className={styles.root}>
    <label className={styles.field}>{t('label')}<input type="text" inputMode="url" value={url} maxLength={16000} disabled={disabled || busy} placeholder="https://…" aria-describedby={`${helpId} ${examplesId}`} onChange={event => { setUrl(event.target.value); setError(''); }} /></label>
    <p id={helpId} className={styles.help}>{t(kind)}</p>
    <div id={examplesId} className={styles.examples}>
      <p>{t('examples')}</p>
      <ul>{examples[kind].map(example => <li key={example.provider}><span>{example.provider}</span><code>{example.url}</code></li>)}</ul>
      <p className={styles.help}>{t('examplesHelp')}</p>
    </div>
    <button type="button" disabled={disabled || busy || !url.trim()} onClick={() => void load()}>{t(busy ? 'loading' : 'import')}</button>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {value && <div role="status"><p>{t('review')}</p><a href={value} target="_blank" rel="noopener noreferrer">{t('selection')}</a> <button type="button" disabled={disabled || busy} onClick={() => { onClear(); setUrl(''); }}>{t('remove')}</button></div>}
  </section>;
}
