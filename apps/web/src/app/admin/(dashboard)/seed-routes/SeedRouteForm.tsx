'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import styles from './page.module.css';

export function SeedRouteForm() {
  const t = useTranslations('AdminSeedRoutes');
  const router = useRouter();
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [originName, setOriginName] = useState('');
  const [destinationName, setDestinationName] = useState('');
  const [cabinClass, setCabinClass] = useState('economy');
  const [airlines, setAirlines] = useState('');
  const [lookAheadDays, setLookAheadDays] = useState(14);
  const [scrapeInterval, setScrapeInterval] = useState(3);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');

    const res = await fetch('/api/admin/seed-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: origin.trim(),
        destination: destination.trim(),
        originName: originName.trim() || undefined,
        destinationName: destinationName.trim() || undefined,
        cabinClass,
        preferredAirlines: airlines ? airlines.split(',').map((a) => a.trim()).filter(Boolean) : [],
        lookAheadDays,
        scrapeInterval,
      }),
    });

    const data = await res.json();
    setSaving(false);

    if (data.ok) {
      setOrigin('');
      setDestination('');
      setOriginName('');
      setDestinationName('');
      setAirlines('');
      setMessage(t('form.created'));
      router.refresh();
    } else {
      setMessage(data.error ?? t('form.failed'));
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <h2 className={styles.formTitle}>{t('form.title')}</h2>
      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.origin')}</label>
          <input
            className={styles.input}
            value={origin}
            onChange={(e) => setOrigin(e.target.value.toUpperCase())}
            placeholder="JFK"
            maxLength={3}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.destination')}</label>
          <input
            className={styles.input}
            value={destination}
            onChange={(e) => setDestination(e.target.value.toUpperCase())}
            placeholder="LAX"
            maxLength={3}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.originName')}</label>
          <input
            className={styles.input}
            value={originName}
            onChange={(e) => setOriginName(e.target.value)}
            placeholder="New York"
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.destinationName')}</label>
          <input
            className={styles.input}
            value={destinationName}
            onChange={(e) => setDestinationName(e.target.value)}
            placeholder="Los Angeles"
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.cabinClass')}</label>
          <select className={styles.select} value={cabinClass} onChange={(e) => setCabinClass(e.target.value)}>
            <option value="economy">{t('form.economy')}</option>
            <option value="premium_economy">{t('form.premiumEconomy')}</option>
            <option value="business">{t('form.business')}</option>
            <option value="first">{t('form.first')}</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.lookAhead')}</label>
          <select className={styles.select} value={lookAheadDays} onChange={(e) => setLookAheadDays(Number(e.target.value))}>
            <option value={7}>{t('form.days', { days: 7 })}</option>
            <option value={14}>{t('form.days', { days: 14 })}</option>
            <option value={21}>{t('form.days', { days: 21 })}</option>
            <option value={30}>{t('form.days', { days: 30 })}</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.scrapeInterval')}</label>
          <select className={styles.select} value={scrapeInterval} onChange={(e) => setScrapeInterval(Number(e.target.value))}>
            <option value={1}>{t('form.everyHours', { hours: 1 })}</option>
            <option value={3}>{t('form.everyHours', { hours: 3 })}</option>
            <option value={6}>{t('form.everyHours', { hours: 6 })}</option>
            <option value={12}>{t('form.everyHours', { hours: 12 })}</option>
            <option value={24}>{t('form.everyHours', { hours: 24 })}</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>{t('form.airlines')}</label>
          <input
            className={styles.input}
            value={airlines}
            onChange={(e) => setAirlines(e.target.value)}
            placeholder="Delta, United, AA"
          />
        </div>
      </div>
      <div className={styles.formActions}>
        <button className={styles.createButton} type="submit" disabled={saving}>
          {saving ? t('form.creating') : t('form.create')}
        </button>
        {message && <span className={styles.message}>{message}</span>}
      </div>
    </form>
  );
}
