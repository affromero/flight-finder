'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DEFAULT_HOTEL_FILTERS, HOTEL_AMENITIES, HOTEL_SOURCES, type HotelSearch } from '@/lib/hotels/types';
import { hotelRequest } from './client';
import styles from './Hotels.module.css';

export function HotelSearchForm({ busy, onSearch }: { busy: boolean; onSearch: (search: HotelSearch) => void }) {
  const t = useTranslations('Hotels');
  const [search, setSearch] = useState<HotelSearch>({ destination: '', dateMode: 'fixed', checkIn: '', checkOut: '', flexibility: 1, minNights: 1, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD', sources: [...HOTEL_SOURCES], filters: { ...DEFAULT_HOTEL_FILTERS } });
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof HotelSearch>(key: K, value: HotelSearch[K]) => setSearch((s) => ({ ...s, [key]: value }));
  const filter = <K extends keyof HotelSearch['filters']>(key: K, value: HotelSearch['filters'][K]) => setSearch((s) => ({ ...s, filters: { ...s.filters, [key]: value } }));
  async function parse() {
    setParsing(true); setError('');
    try { const result = await hotelRequest<{ search: HotelSearch }>('/api/hotels/parse', { method: 'POST', body: JSON.stringify({ text }) }); setSearch(result.search); }
    catch (e) { setError(e instanceof Error ? e.message : t('failed')); }
    finally { setParsing(false); }
  }
  return <form className={styles.form} onSubmit={(e) => { e.preventDefault(); onSearch({ ...search, filters: { ...search.filters, excludedSellers: search.filters.excludedSellers.filter(Boolean) } }); }}>
    <fieldset disabled={busy || parsing}>
      <legend>{t('findStay')}</legend>
      <label className={styles.field}>{t('describe')}<textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t('example')} /></label>
      <div className={styles.actions}><button className={styles.secondary} type="button" disabled={!text.trim()} onClick={() => void parse()}>{parsing ? t('parsing') : t('fillDetails')}</button><span className={styles.muted}>{t('reviewDetails')}</span></div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </fieldset>
    <fieldset disabled={busy || parsing}>
      <legend>{t('stayDetails')}</legend>
      <div className={styles.grid}>
        <label className={`${styles.field} ${styles.wide}`}>{t('destination')}<input required value={search.destination} onChange={(e) => update('destination', e.target.value)} /></label>
        <label className={styles.field}>{t('dates')}<select value={search.dateMode} onChange={(e) => update('dateMode', e.target.value as HotelSearch['dateMode'])}>{(['fixed', 'nearby', 'window'] as const).map((mode) => <option key={mode} value={mode}>{t(mode)}</option>)}</select></label>
        <label className={styles.field}>{t(search.dateMode === 'window' ? 'windowStart' : 'checkIn')}<input required type="date" value={search.checkIn} onChange={(e) => update('checkIn', e.target.value)} /></label>
        <label className={styles.field}>{t(search.dateMode === 'window' ? 'windowEnd' : 'checkOut')}<input required type="date" min={search.checkIn} value={search.checkOut} onChange={(e) => update('checkOut', e.target.value)} /></label>
        {search.dateMode === 'nearby' && <label className={styles.field}>{t('flexibility')}<input type="number" min="1" max="3" value={search.flexibility} onChange={(e) => update('flexibility', Number(e.target.value))} /></label>}
        {search.dateMode === 'window' && <><label className={styles.field}>{t('minNights')}<input type="number" min="1" max="30" value={search.minNights} onChange={(e) => update('minNights', Number(e.target.value))} /></label><label className={styles.field}>{t('maxNights')}<input type="number" min={search.minNights} max="30" value={search.maxNights} onChange={(e) => update('maxNights', Number(e.target.value))} /></label></>}
        <label className={styles.field}>{t('currency')}<select value={search.currency} onChange={(e) => update('currency', e.target.value)}>{['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'BRL', 'COP', 'MXN', 'CHF', 'JPY', 'INR'].map((currency) => <option key={currency}>{currency}</option>)}</select></label>
      </div>
      {search.dateMode === 'nearby' && <p className={styles.muted}>{t('nearbyHelp')}</p>}
      <div className={styles.checks}>{HOTEL_SOURCES.map((source) => <label className={styles.check} key={source}><input type="checkbox" checked={search.sources.includes(source)} onChange={(e) => update('sources', e.target.checked ? [...search.sources, source] : search.sources.filter((s) => s !== source))} />{source === 'booking' ? 'Booking.com' : 'Google Hotels'}</label>)}</div>
      {search.rooms.length > 1 && search.sources.includes('google_hotels') && <p className={styles.notice}>{t('googleSingleRoom')}</p>}
    </fieldset>
    <fieldset disabled={busy || parsing}><legend>{t('guests')}</legend>
      {search.rooms.map((room, index) => <div className={styles.room} key={index}>
        <div className={styles.grid}><label className={styles.field}>{t('roomAdults', { room: index + 1 })}<input type="number" min="1" max="6" value={room.adults} onChange={(e) => update('rooms', search.rooms.map((r, i) => i === index ? { ...r, adults: Number(e.target.value) } : r))} /></label>
          <label className={styles.field}>{t('children')}<input type="number" min="0" max="4" value={room.children.length} onChange={(e) => update('rooms', search.rooms.map((r, i) => i === index ? { ...r, children: [...Array<number>(Math.max(0, Math.min(4, Number(e.target.value)))).keys()].map((child) => r.children[child] ?? 0) } : r))} /></label>
          {room.children.map((age, child) => <label className={styles.field} key={child}>{t('childAge', { child: child + 1, room: index + 1 })}<input required type="number" min="0" max="17" value={age} onChange={(e) => update('rooms', search.rooms.map((r, i) => i === index ? { ...r, children: r.children.map((a, c) => c === child ? Number(e.target.value) : a) } : r))} /></label>)}
        </div>
        {search.rooms.length > 1 && <button className={styles.secondary} type="button" onClick={() => update('rooms', search.rooms.filter((r, i) => i !== index))}>{t('removeRoom', { room: index + 1 })}</button>}
      </div>)}
      <button className={styles.secondary} type="button" disabled={search.rooms.length >= 4} onClick={() => update('rooms', [...search.rooms, { adults: 2, children: [] }])}>{t('addRoom')}</button>
    </fieldset>
    <details className={styles.filterDetails}><summary>{t('filters')}</summary><fieldset disabled={busy || parsing} aria-label={t('filters')}><p className={styles.muted}>{t('unknownFilters')}</p>
      <div className={styles.grid}>
        <label className={styles.field}>{t('maxTotal')}<input type="number" min="0.01" step="0.01" value={search.filters.maxTotal ?? ''} onChange={(e) => filter('maxTotal', e.target.value ? Number(e.target.value) : null)} /></label>
        <label className={styles.field}>{t('minStars')}<select value={search.filters.minStars} onChange={(e) => filter('minStars', Number(e.target.value))}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n || t('any')}</option>)}</select></label>
        <label className={styles.field}>{t('minRating')}<input type="number" min="0" max="10" step="0.1" value={search.filters.minRating} onChange={(e) => filter('minRating', Number(e.target.value))} /></label>
        <label className={`${styles.field} ${styles.wide}`}>{t('excludedSellers')}<input value={search.filters.excludedSellers.join(', ')} onChange={(e) => filter('excludedSellers', e.target.value.split(',').map((s) => s.trim()))} /></label>
      </div>
      <div className={styles.checks}>{(['refundable', 'breakfast'] as const).map((key) => <label className={styles.check} key={key}><input type="checkbox" checked={search.filters[key]} onChange={(e) => filter(key, e.target.checked)} />{t(key)}</label>)}{HOTEL_AMENITIES.map((key) => <label className={styles.check} key={key}><input type="checkbox" checked={search.filters.amenities.includes(key)} onChange={(e) => filter('amenities', e.target.checked ? [...search.filters.amenities, key] : search.filters.amenities.filter((a) => a !== key))} />{t(key)}</label>)}</div>
    </fieldset></details>
    <button className={styles.button} type="submit" disabled={busy || parsing || !search.sources.length}>{busy ? t('searching') : t('search')}</button>
  </form>;
}
