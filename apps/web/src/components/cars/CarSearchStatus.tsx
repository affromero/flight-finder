'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { carRunIsActive, validateCarRunView, type CarRunView } from '@/lib/cars/run-view';
import { carRecord } from '@/lib/cars/validation';
import { carSearchIdentity } from '@/lib/cars/search-identity';
import { travelRequest, TravelResponseError, TRAVEL_ACCESS_LOST_EVENT } from '../travel/client';
import { CarResults } from './CarResults';
import styles from './Cars.module.css';

export const CAR_STATUS_TIMEOUT_MS = 15_000;
export function CarSearchStatus({ initial, actorScope }: { initial: CarRunView; actorScope: string }) {
  const t = useTranslations('Cars');
  const [job, setJob] = useState(initial), [paused, setPaused] = useState(false), [error, setError] = useState('');
  const [privateHidden, setPrivateHidden] = useState(false), [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const current = useRef(initial), generation = useRef(0), controller = useRef<AbortController | null>(null);
  const url = `/api/cars/search/${encodeURIComponent(initial.id)}`;
  const loseAccess = useCallback(() => {
    generation.current++; controller.current?.abort(); controller.current = null;
    setPrivateHidden(true); setPaused(true); setBusy(false); setCancelling(false);
    setError(t('accessLost'));
  }, [t]);
  useEffect(() => {
    window.addEventListener(TRAVEL_ACCESS_LOST_EVENT, loseAccess);
    return () => window.removeEventListener(TRAVEL_ACCESS_LOST_EVENT, loseAccess);
  }, [loseAccess]);
  const read = useCallback(async (cancel = false) => {
    const sequence = ++generation.current;
    controller.current?.abort(); const aborter = new AbortController(); controller.current = aborter;
    setBusy(true); setCancelling(cancel);
    const timeout = setTimeout(() => aborter.abort(), CAR_STATUS_TIMEOUT_MS);
    try {
      if (cancel) {
        const acknowledgement = carRecord(await travelRequest<unknown>(url, { method: 'DELETE', signal: aborter.signal }));
        if (sequence !== generation.current) return;
        aborter.signal.throwIfAborted();
        if (acknowledgement.id !== initial.id || !['cancelled', 'success', 'partial', 'failed', 'unavailable'].includes(String(acknowledgement.status))) throw new Error('Cancellation outcome is not confirmed');
      }
      const next = validateCarRunView(await travelRequest<unknown>(url, { signal: aborter.signal, cache: 'no-store' }), initial.id, true);
      if (sequence !== generation.current) return;
      if (aborter.signal.aborted) throw new Error('Status request exceeded its deadline');
      if (carSearchIdentity(next.search) !== carSearchIdentity(initial.search) || next.createdAt !== initial.createdAt) throw new Error('Search identity changed');
      if (!carRunIsActive(current.current) && current.current.status !== next.status) throw new Error('Search status regressed');
      if (current.current.trackingClosed && !next.trackingClosed) throw new Error('Search tracking closure regressed');
      current.current = next; setJob(next); setError(''); setPaused(false); setPrivateHidden(false);
    } catch (failure) {
      if (sequence !== generation.current) return;
      const hidden = failure instanceof TravelResponseError && [401, 403, 404].includes(failure.status);
      setPrivateHidden(previous => previous || hidden); setPaused(true);
      const pausedMessage = !cancel && failure instanceof TravelResponseError && failure.definitive && failure.status === 503;
      setError(pausedMessage ? failure.message : t(hidden ? 'accessLost' : cancel ? 'cancelUncertain' : 'statusInterrupted'));
    } finally {
      clearTimeout(timeout);
      if (controller.current === aborter) controller.current = null;
      if (sequence === generation.current) { setBusy(false); setCancelling(false); }
    }
  }, [initial.id, initial.createdAt, initial.search, t, url]);
  useEffect(() => {
    if (paused || privateHidden || busy || !carRunIsActive(job)) return;
    const timer = setTimeout(() => void read(), 1500);
    return () => clearTimeout(timer);
  }, [job, paused, privateHidden, busy, read]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, [initial.id, actorScope]);

  const result = job.result ?? { scope: 'checked_provider_offers' as const, offers: [], candidates: [], errors: [], completed: 0, total: job.search.sources.length, providers: [], successfulProviders: 0 };
  return <>
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy} onClick={() => void read()}>{t(paused ? 'retryStatus' : 'refreshStatus')}</button>
      {!privateHidden && carRunIsActive(job) && <button className={styles.secondary} type="button" disabled={cancelling} onClick={() => void read(true)}>{t('cancelSearch')}</button>}
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {busy && <p role="status" className={styles.notice}>{t('updatingStatus')}</p>}
    {privateHidden ? <Link className={styles.secondary} href={`/login?next=${encodeURIComponent(`/cars/search/${initial.id}`)}`}>{t('signIn')}</Link> : <>
      {job.error && <p role="alert" className={styles.error}>{job.error}</p>}
      <CarResults actorScope={actorScope} searchId={job.id} search={job.search} report={result} status={job.status} trackingClosed={job.trackingClosed} mutationsDisabled={paused || busy} onAccessLost={loseAccess} />
    </>}
  </>;
}
