'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { HotelSearch, HotelSearchResult } from '@/lib/hotels/types';
import { hotelRequest } from './client';
import { HotelSearchForm } from './HotelSearchForm';
import { HotelOfferCard } from './HotelOfferCard';
import { HotelOptions, defaultHotelOptions } from './HotelOptions';
import styles from './Hotels.module.css';
interface SearchJob { id: string; status: string; result: HotelSearchResult | null; error: string | null }
export function HotelSearchExperience() {
  const t = useTranslations('Hotels'); const router = useRouter();
  const [job, setJob] = useState<SearchJob | null>(null);
  const [starting, setStarting] = useState(false); const [tracking, setTracking] = useState(false);
  const [error, setError] = useState(''); const [options, setOptions] = useState(defaultHotelOptions);
  const [pollingPaused, setPollingPaused] = useState(false);
  const failed = t('failed');
  const generation = useRef(0);
  const running = job?.status === 'queued' || job?.status === 'running';
  const canTrack = job?.status === 'success' || job?.status === 'partial';
  useEffect(() => {
    if (!running || !job || pollingPaused) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const next = await hotelRequest<SearchJob>(`/api/hotels/search/${job!.id}`); if (!disposed) { setJob(next); if (next.status === 'queued' || next.status === 'running') timer = setTimeout(() => void poll(), 2000); } }
      catch (e) { if (!disposed) { setError(e instanceof Error ? e.message : failed); setPollingPaused(true); } }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id, running, pollingPaused, failed]);
  async function search(value: HotelSearch) {
    const current = ++generation.current; setStarting(true); setError(''); setPollingPaused(false); setJob(null);
    try { const created = await hotelRequest<SearchJob>('/api/hotels/search', { method: 'POST', body: JSON.stringify(value) }); if (current === generation.current) setJob(created); }
    catch (e) { setError(e instanceof Error ? e.message : t('failed')); }
    finally { setStarting(false); }
  }
  async function cancel() {
    if (!job) return;
    try { await hotelRequest(`/api/hotels/search/${job.id}`, { method: 'DELETE' }); setJob({ ...job, status: 'cancelled' }); setPollingPaused(false); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : t('failed')); }
  }
  async function track(offerId: string) {
    if (!job || !canTrack) return; setTracking(true); setError('');
    try { const result = await hotelRequest<{ tracker: { id: string } }>('/api/hotels', { method: 'POST', body: JSON.stringify({ searchId: job.id, offerId, ...options }) }); router.push(`/hotels/${result.tracker.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : t('failed')); setTracking(false); }
  }
  return <><HotelSearchForm busy={starting || running || tracking} onSearch={(value) => void search(value)} />
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {running && <div role="status" className={styles.notice}>{t(pollingPaused ? 'statusInterrupted' : 'searchingHelp')}<div className={styles.actions}>{pollingPaused && <button className={styles.secondary} onClick={() => { setError(''); setPollingPaused(false); }}>{t('retryStatus')}</button>}<button className={styles.secondary} onClick={() => void cancel()}>{t('cancel')}</button></div></div>}
    {job?.error && <p role="alert" className={styles.error}>{job.error}</p>}
    {job?.status === 'cancelled' && <p role="status">{t('cancelled')}</p>}
    {job?.result && <section className={styles.section} aria-label={t('results')}><h2 className={styles.heading}>{t('results')} · {job.result.offers.length}</h2><p className={styles.muted}>{t('discoveryLimit')}</p>
      {job.result.errors.map((entry, i) => <p role="alert" className={styles.error} key={i}>{entry.source} · {entry.checkIn} → {entry.checkOut}: {entry.message}</p>)}
      {running && <p className={styles.muted}>{t('progress', { completed: job.result.completed, total: job.result.total })}</p>}
      {!job.result.offers.length ? (canTrack || job.status === 'unavailable') && <p className={styles.notice}>{t('noOffers')}</p> : <><form className={styles.form} onSubmit={(e) => e.preventDefault()}><HotelOptions value={options} onChange={setOptions} /></form><div className={`${styles.offers} ${styles.section}`}>{job.result.offers.map((offer) => <HotelOfferCard key={offer.id} offer={offer} busy={tracking || !canTrack} onTrack={() => void track(offer.id)} />)}</div></>}
    </section>}
  </>;
}
