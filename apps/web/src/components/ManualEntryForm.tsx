'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ParsedQuery } from './ConfirmationCard';
import { AirportCombobox } from './AirportCombobox';
import { detectLocaleCurrency } from '@/lib/currency';
import styles from './ManualEntryForm.module.css';

export interface ManualFormValues {
  origin: { code: string; name: string } | null;
  destination: { code: string; name: string } | null;
  dateFrom: string;
  dateTo: string;
  tripType: 'one_way' | 'round_trip';
  flexibility: number;
  maxPrice: string;
  maxStops: string;
  maxDuration: string;
  airlines: string;
  timePreference: 'any' | 'morning' | 'afternoon' | 'evening' | 'redeye';
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
  currency: string;
}

interface ManualEntryFormProps {
  onSubmit: (query: ParsedQuery, rawInput: string, formValues: ManualFormValues) => void;
  onCancel: () => void;
  adminCurrency: string | null;
  cancelLabel?: string;
  initialValues?: ManualFormValues;
}

interface SelectedAirport {
  code: string;
  name: string;
}

function synthesizeRawInput(
  origin: SelectedAirport,
  destination: SelectedAirport,
  dateFrom: string,
  dateTo: string,
  tripType: 'one_way' | 'round_trip',
  cabinClass: string,
): string {
  const parts = [`${origin.code} ${origin.name} to ${destination.code} ${destination.name}`];
  parts.push(dateFrom);
  if (tripType === 'round_trip' && dateTo) {
    parts.push(`to ${dateTo}`);
  }
  parts.push(tripType === 'round_trip' ? 'round trip' : 'one way');
  if (cabinClass !== 'economy') {
    parts.push(cabinClass.replace('_', ' '));
  }
  return parts.join(' ');
}

export function ManualEntryForm({
  onSubmit,
  onCancel,
  adminCurrency,
  cancelLabel,
  initialValues,
}: ManualEntryFormProps) {
  const t = useTranslations('ManualEntryForm');
  const iv = initialValues;
  const [origin, setOrigin] = useState<SelectedAirport | null>(iv?.origin ?? null);
  const [destination, setDestination] = useState<SelectedAirport | null>(iv?.destination ?? null);
  const [dateFrom, setDateFrom] = useState(iv?.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(iv?.dateTo ?? '');
  const [tripType, setTripType] = useState<'one_way' | 'round_trip'>(iv?.tripType ?? 'round_trip');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const hasAdvancedInitial = iv ? !!(
    iv.flexibility > 0 ||
    iv.maxPrice ||
    iv.maxStops ||
    iv.maxDuration ||
    iv.airlines ||
    iv.timePreference !== 'any' ||
    iv.cabinClass !== 'economy'
  ) : false;
  const [showAdvanced, setShowAdvanced] = useState(hasAdvancedInitial);
  const [flexibility, setFlexibility] = useState(iv?.flexibility ?? 0);
  const [maxPrice, setMaxPrice] = useState(iv?.maxPrice ?? '');
  const [maxStops, setMaxStops] = useState(iv?.maxStops ?? '');
  const [maxDuration, setMaxDuration] = useState(iv?.maxDuration ?? '');
  const [airlines, setAirlines] = useState(iv?.airlines ?? '');
  const [timePreference, setTimePreference] = useState<'any' | 'morning' | 'afternoon' | 'evening' | 'redeye'>(
    iv?.timePreference ?? 'any',
  );
  const [cabinClass, setCabinClass] = useState<'economy' | 'premium_economy' | 'business' | 'first'>(
    iv?.cabinClass ?? 'economy',
  );
  const [currency, setCurrency] = useState(iv?.currency ?? '');

  const clearError = (field: string) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const validate = (): Record<string, string> | null => {
    const errors: Record<string, string> = {};

    if (!origin) errors.origin = t('selectOrigin');
    if (!destination) errors.destination = t('selectDestination');
    if (origin && destination && origin.code === destination.code) {
      errors.destination = t('destinationDiffers');
    }
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (!dateFrom) {
      errors.dateFrom = t('selectDeparture');
    } else if (dateFrom < todayStr) {
      errors.dateFrom = t('dateInPast');
    }
    if (tripType === 'round_trip') {
      if (!dateTo) {
        errors.dateTo = t('selectReturn');
      } else if (dateFrom && dateTo <= dateFrom) {
        errors.dateTo = t('returnAfterDeparture');
      }
    }
    if (maxDuration) {
      const n = parseInt(maxDuration, 10);
      if (!Number.isInteger(n) || n < 1 || n > 48) {
        errors.maxDuration = t('durationRange');
      }
    }

    return Object.keys(errors).length > 0 ? errors : null;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validate();
    if (errors) {
      setFieldErrors(errors);
      return;
    }

    const o = origin!;
    const d = destination!;

    const query: ParsedQuery = {
      origin: o.code,
      originName: o.name,
      destination: d.code,
      destinationName: d.name,
      origins: [{ code: o.code, name: o.name }],
      destinations: [{ code: d.code, name: d.name }],
      dateFrom,
      dateTo: tripType === 'round_trip' ? dateTo : dateFrom,
      flexibility,
      maxPrice: maxPrice ? parseInt(maxPrice, 10) : null,
      maxStops: maxStops === '' ? null : parseInt(maxStops, 10),
      maxDurationHours: maxDuration ? parseInt(maxDuration, 10) : null,
      preferredAirlines: airlines ? airlines.split(',').map((s) => s.trim()).filter(Boolean) : [],
      timePreference,
      cabinClass,
      tripType,
      currency: currency || adminCurrency || detectLocaleCurrency(),
    };

    if (flexibility > 0) {
      const from = new Date(dateFrom + 'T00:00:00');
      from.setDate(from.getDate() - flexibility);
      query.dateFrom = from.toISOString().split('T')[0]!;
      const to = new Date((tripType === 'round_trip' ? dateTo : dateFrom) + 'T00:00:00');
      to.setDate(to.getDate() + flexibility);
      query.dateTo = to.toISOString().split('T')[0]!;
    }

    const rawInput = synthesizeRawInput(o, d, dateFrom, dateTo, tripType, cabinClass);
    const formValues: ManualFormValues = {
      origin: o,
      destination: d,
      dateFrom,
      dateTo: tripType === 'round_trip' ? dateTo : dateFrom,
      tripType,
      flexibility,
      maxPrice,
      maxStops,
      maxDuration,
      airlines,
      timePreference,
      cabinClass,
      currency,
    };
    onSubmit(query, rawInput, formValues);
  };

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return (
    <form className={styles.root} onSubmit={handleSubmit} noValidate>
      <AirportCombobox
        id="me-origin"
        label={t('origin')}
        placeholder={t('originPlaceholder')}
        value={origin}
        onChange={(v) => { setOrigin(v); clearError('origin'); }}
        error={fieldErrors.origin}
        excludeCode={destination?.code}
        autoFocus={!iv}
      />

      <AirportCombobox
        id="me-dest"
        label={t('destination')}
        placeholder={t('destinationPlaceholder')}
        value={destination}
        onChange={(v) => { setDestination(v); clearError('destination'); }}
        error={fieldErrors.destination}
        excludeCode={origin?.code}
      />

      <div className={styles.tripToggle}>
        <button
          type="button"
          className={`${styles.tripOption} ${tripType === 'round_trip' ? styles.tripOptionActive : ''}`}
          onClick={() => setTripType('round_trip')}
        >
          {t('roundTrip')}
        </button>
        <button
          type="button"
          className={`${styles.tripOption} ${tripType === 'one_way' ? styles.tripOptionActive : ''}`}
          onClick={() => setTripType('one_way')}
        >
          {t('oneWay')}
        </button>
      </div>

      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="me-date-from">{t('departure')}</label>
          <input
            id="me-date-from"
            className={`${styles.input} ${fieldErrors.dateFrom ? styles.inputError : ''}`}
            type="date"
            min={today}
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); clearError('dateFrom'); }}
            aria-required
            aria-invalid={!!fieldErrors.dateFrom}
          />
          {fieldErrors.dateFrom && <span className={styles.errorText}>{fieldErrors.dateFrom}</span>}
        </div>
        {tripType === 'round_trip' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="me-date-to">{t('return')}</label>
            <input
              id="me-date-to"
              className={`${styles.input} ${fieldErrors.dateTo ? styles.inputError : ''}`}
              type="date"
              min={dateFrom || today}
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); clearError('dateTo'); }}
              aria-required
              aria-invalid={!!fieldErrors.dateTo}
            />
            {fieldErrors.dateTo && <span className={styles.errorText}>{fieldErrors.dateTo}</span>}
          </div>
        )}
      </div>

      <button
        type="button"
        className={styles.advancedToggle}
        onClick={() => setShowAdvanced(!showAdvanced)}
        aria-expanded={showAdvanced}
      >
        <span>{t('advancedOptions')}</span>
        <svg
          className={`${styles.chevron} ${showAdvanced ? styles.chevronOpen : ''}`}
          width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {showAdvanced && (
        <div className={styles.advancedPanel}>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-flexibility">{t('flexibilityDays')}</label>
              <input
                id="me-flexibility"
                className={styles.input}
                type="number"
                min={0}
                max={7}
                value={flexibility}
                onChange={(e) => setFlexibility(Math.max(0, Math.min(7, parseInt(e.target.value, 10) || 0)))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-max-price">{t('maxPrice')}</label>
              <input
                id="me-max-price"
                className={styles.input}
                type="number"
                min={0}
                placeholder={t('noLimit')}
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-time">{t('timePreference')}</label>
              <select
                id="me-time"
                className={styles.input}
                value={timePreference}
                onChange={(e) => setTimePreference(e.target.value as typeof timePreference)}
              >
                <option value="any">{t('any')}</option>
                <option value="morning">{t('morning')}</option>
                <option value="afternoon">{t('afternoon')}</option>
                <option value="evening">{t('evening')}</option>
                <option value="redeye">{t('redEye')}</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-cabin">{t('cabinClass')}</label>
              <select
                id="me-cabin"
                className={styles.input}
                value={cabinClass}
                onChange={(e) => setCabinClass(e.target.value as typeof cabinClass)}
              >
                <option value="economy">{t('economy')}</option>
                <option value="premium_economy">{t('premiumEconomy')}</option>
                <option value="business">{t('business')}</option>
                <option value="first">{t('first')}</option>
              </select>
            </div>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-max-stops">{t('maxStops')}</label>
              <select
                id="me-max-stops"
                className={styles.input}
                value={maxStops}
                onChange={(e) => setMaxStops(e.target.value)}
              >
                <option value="">{t('any')}</option>
                <option value="0">{t('nonstopOnly')}</option>
                <option value="1">{t('maxOneStop')}</option>
                <option value="2">{t('maxTwoStops')}</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-max-duration">{t('maxDuration')}</label>
              <input
                id="me-max-duration"
                className={`${styles.input} ${fieldErrors.maxDuration ? styles.inputError : ''}`}
                type="number"
                min={1}
                max={48}
                placeholder={t('noLimit')}
                value={maxDuration}
                onChange={(e) => { setMaxDuration(e.target.value); clearError('maxDuration'); }}
                aria-invalid={!!fieldErrors.maxDuration}
              />
              {fieldErrors.maxDuration && <span className={styles.errorText}>{fieldErrors.maxDuration}</span>}
            </div>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="me-currency">{t('currency')}</label>
              <input
                id="me-currency"
                className={styles.input}
                type="text"
                placeholder={t('autoDetect')}
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
            <div className={styles.field} aria-hidden="true" />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="me-airlines">{t('preferredAirlines')}</label>
            <input
              id="me-airlines"
              className={styles.input}
              type="text"
              placeholder={t('airlinesPlaceholder')}
              value={airlines}
              onChange={(e) => setAirlines(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton}>
          {t('showAvailableFlights')}
        </button>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>
          {cancelLabel ?? t('cancel')}
        </button>
      </div>
    </form>
  );
}
