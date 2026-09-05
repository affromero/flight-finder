'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { hotelHistoryObservations, hotelMoney, hotelRequest, safeHotelUrl, type HotelDetailView } from './client';
import { HotelOptions, defaultHotelOptions } from './HotelOptions';
import styles from './Hotels.module.css';
export function HotelDetail({ id, canReassign = false }: { id: string; canReassign?: boolean }) {
  const t = useTranslations('Hotels'); const locale = useLocale(); const router = useRouter();
  const failed = t('failed');
  const [data, setData] = useState<HotelDetailView | null>(null); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const [refreshing, setRefreshing] = useState(false); const [saved, setSaved] = useState(false);
  const [options, setOptions] = useState(defaultHotelOptions);
  const [users, setUsers] = useState<{ id: string; username: string; displayName: string | null }[]>([]);
  const [owner, setOwner] = useState('');
  useEffect(() => {
    if (!canReassign) return;
    let disposed = false;
    hotelRequest<{ users: typeof users }>('/api/admin/users').then((result) => { if (!disposed) setUsers(result.users); }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : failed); });
    return () => { disposed = true; };
  }, [canReassign, failed]);
  const load = useCallback(async () => { const result = await hotelRequest<HotelDetailView>(`/api/hotels/${id}`); setData(result); return result; }, [id]);
  useEffect(() => { let disposed = false; hotelRequest<HotelDetailView>(`/api/hotels/${id}`).then((result) => { if (!disposed) { setData(result); setOptions(result.tracker.options); setRefreshing(result.runs.some((run) => run.status === 'running' || run.status === 'queued')); } }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : failed); }); return () => { disposed = true; }; }, [id, failed]);
  useEffect(() => {
    if (!refreshing) return;
    const interval = setInterval(() => { void load().then((result) => { if (!result.runs.some((run) => run.status === 'running' || run.status === 'queued')) setRefreshing(false); }).catch((e: unknown) => { setError(e instanceof Error ? e.message : failed); setRefreshing(false); }); }, 2000);
    return () => clearInterval(interval);
  }, [refreshing, load, failed]);
  async function mutate(method: string, body?: object, suffix = '') {
    setBusy(true); setError(''); setSaved(false);
    try { await hotelRequest(`/api/hotels/${id}${suffix}`, { method, body: body ? JSON.stringify(body) : undefined });
      if (method === 'DELETE') { router.push('/hotels'); return; }
      if (suffix) setRefreshing(true);
      await load(); if (method === 'PATCH') setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : t('failed')); }
    finally { setBusy(false); }
  }
  const prices = hotelHistoryObservations(data?.snapshots ?? []).map((snapshot) => ({ checked: new Date(snapshot.scrapedAt).toLocaleString(locale), price: snapshot.offer.totalPrice, stay: `${snapshot.offer.checkIn} → ${snapshot.offer.checkOut}`, match: t(snapshot.offer.match) }));
  if (!data) return <p role={error ? 'alert' : 'status'} className={error ? styles.error : styles.notice}>{error || t('loading')}</p>;
  const { tracker } = data;
  return <><header className={styles.hero}><span className={styles.eyebrow}>{t(tracker.active ? 'active' : 'paused')} · {t(tracker.options.mode)}</span><h1>{tracker.hotelName}</h1><p className={styles.muted}>{tracker.search.destination} · {tracker.search.checkIn} → {tracker.search.checkOut} · {t('roomCount', { count: tracker.search.rooms.length })}</p><p className={styles.price}>{tracker.latestPrice === null ? t('noPrice') : hotelMoney(tracker.latestPrice, tracker.currency, locale)}</p></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}{tracker.lastError && <p role="alert" className={styles.error}>{tracker.lastError}</p>}
    {!data.notificationsConfigured && <p className={styles.notice}>{t('configureNotifications')} <a href="/settings">{t('settings')}</a></p>}
    <div className={styles.actions}><button className={styles.button} disabled={busy || refreshing || !tracker.active} onClick={() => void mutate('POST', undefined, '/scrape')}>{refreshing ? t('refreshing') : t('refresh')}</button><button className={styles.secondary} disabled={busy} onClick={() => void mutate('PATCH', { active: !tracker.active })}>{t(tracker.active ? 'pause' : 'resume')}</button><button className={styles.secondary} disabled={busy} onClick={() => { if (window.confirm(t('confirmDelete'))) void mutate('DELETE'); }}>{t('delete')}</button></div>
    <section className={styles.section}><h2 className={styles.heading}>{t('stayDetails')}</h2><p className={styles.muted}>{t(tracker.search.dateMode)} · {tracker.selection.seller}{tracker.options.mode === 'room' && ` · ${tracker.selection.roomName ?? t('unknownRoom')} · ${tracker.selection.rateName ?? t('unknown')}`}</p><ul className={styles.list}>{tracker.search.rooms.map((room, index) => <li className={styles.row} key={index}><span>{t('roomAdults', { room: index + 1 })}: {room.adults}</span><span>{t('children')}: {room.children.length ? room.children.join(', ') : '0'}</span></li>)}</ul><div className={styles.tags}>{tracker.search.filters.refundable && <span>{t('refundable')}</span>}{tracker.search.filters.breakfast && <span>{t('breakfast')}</span>}{tracker.search.filters.amenities.map((amenity) => <span key={amenity}>{t(amenity)}</span>)}{tracker.search.filters.minStars > 0 && <span>{t('minStars')}: {tracker.search.filters.minStars}</span>}{tracker.search.filters.minRating > 0 && <span>{t('minRating')}: {tracker.search.filters.minRating}</span>}{tracker.search.filters.excludedSellers.length > 0 && <span>{t('excludedSellers')}: {tracker.search.filters.excludedSellers.join(', ')}</span>}</div></section>
    <section className={styles.section}><h2 className={styles.heading}>{t('history')}</h2><p className={styles.muted}>{t('historyHelp')}</p>{!prices.length ? <p>{t('noHistory')}</p> : <div className={styles.chart} role="img" aria-label={t('history')}><ResponsiveContainer width="100%" height="100%"><LineChart data={prices}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="checked" stroke="var(--text-secondary)" minTickGap={30} tickFormatter={(value: string) => value.split(',')[0] ?? value} /><YAxis stroke="var(--text-secondary)" width={65} domain={['auto', 'auto']} /><Tooltip content={({ active, payload }) => {
      const point = payload?.[0]?.payload as typeof prices[number] | undefined;
      if (!active || !point) return null;
      return <div className={styles.tooltip}><strong>{hotelMoney(point.price, tracker.currency, locale)}</strong><p>{point.stay}</p><p>{point.match}</p><span className={styles.muted}>{point.checked}</span></div>;
    }} /><Line dataKey="price" name={tracker.currency} stroke="var(--accent)" strokeWidth={2} isAnimationActive={false} dot /></LineChart></ResponsiveContainer></div>}
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{['checked', 'dates', 'total', 'seller', 'roomOffer', 'refundable', 'breakfast', 'matchMode'].map((key) => <th key={key} scope="col">{t(key)}</th>)}</tr></thead><tbody>{data.snapshots.map((snapshot) => <tr key={snapshot.id}><td>{new Date(snapshot.scrapedAt).toLocaleString(locale)}</td><td>{snapshot.offer.checkIn} → {snapshot.offer.checkOut}</td><td>{hotelMoney(snapshot.offer.totalPrice, snapshot.offer.currency, locale)}</td><td>{safeHotelUrl(snapshot.offer.bookingUrl) ? <a href={safeHotelUrl(snapshot.offer.bookingUrl)} target="_blank" rel="noopener noreferrer">{snapshot.offer.seller}</a> : snapshot.offer.seller}</td><td>{snapshot.offer.roomName ?? t('unknownRoom')}<br /><span className={styles.muted}>{snapshot.offer.rateName ?? t('unknown')}</span></td><td>{t(snapshot.offer.refundable === null ? 'unknown' : snapshot.offer.refundable ? 'yes' : 'no')}</td><td>{t(snapshot.offer.breakfast === null ? 'unknown' : snapshot.offer.breakfast ? 'yes' : 'no')}</td><td>{t(snapshot.offer.match)}{!snapshot.eligible && ` · ${t('ineligible')}`}</td></tr>)}</tbody></table></div>
    </section>
    <section className={styles.section}><form className={styles.form} onSubmit={(e) => { e.preventDefault(); const { targetPrice, notifyLows, allowApproximateAlerts, scrapeInterval } = options; void mutate('PATCH', { targetPrice, notifyLows, allowApproximateAlerts, scrapeInterval }); }}><HotelOptions value={options} onChange={setOptions} edit /><button className={styles.button} disabled={busy}>{t('save')}</button>{saved && <p role="status">{t('savedChanges')}</p>}</form></section>
    {canReassign && <section className={styles.section}><form className={styles.form} onSubmit={(e) => { e.preventDefault(); void mutate('PATCH', { userId: owner }); }}><label className={styles.field}>{t('owner')}<select required value={owner || tracker.userId || ''} onChange={(e) => setOwner(e.target.value)}><option value="" disabled>{t('chooseOwner')}</option>{users.map((user) => <option key={user.id} value={user.id}>{user.displayName || user.username}</option>)}</select></label><div className={styles.actions}><button className={styles.secondary} disabled={busy || !owner || owner === tracker.userId}>{t('reassign')}</button></div></form></section>}
    <section className={styles.section}><h2 className={styles.heading}>{t('checks')}</h2><ul className={styles.list}>{data.runs.map((run) => <li key={run.id} className={styles.row}><span>{new Date(run.createdAt).toLocaleString(locale)} · {t(`status_${run.status}`)}</span>{run.error && <span className={styles.error}>{run.error}</span>}</li>)}</ul></section>
  </>;
}
