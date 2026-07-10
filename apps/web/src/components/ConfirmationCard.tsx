'use client';

import { useState, useEffect } from 'react';
import type { Airport } from '@/lib/scraper/parse-query';
import { formatCurrency } from '@/lib/currency';
import styles from './ConfirmationCard.module.css';

export interface ParsedQuery {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  origins: Airport[];
  destinations: Airport[];
  dateFrom: string;
  dateTo: string;
  outboundDates?: string[];
  returnDates?: string[];
  flexibility: number;
  maxPrice: number | null;
  maxStops: number | null;
  maxDurationHours: number | null;
  preferredAirlines: string[];
  timePreference: string;
  cabinClass: string;
  tripType: string;
  currency: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function hasFilters(p: ParsedQuery): boolean {
  return !!(
    p.maxPrice ||
    p.maxStops !== null ||
    (p.maxDurationHours !== null && p.maxDurationHours > 0) ||
    p.preferredAirlines.length > 0 ||
    p.timePreference !== 'any' ||
    p.cabinClass !== 'economy'
  );
}

function computeExpiry(dateTo: string, flexibility: number): string {
  const d = new Date(dateTo + 'T00:00:00');
  d.setDate(d.getDate() + flexibility);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const POPULAR_COUNTRIES = [
  { code: 'US', flag: '\u{1F1FA}\u{1F1F8}', name: 'US' },
  { code: 'GB', flag: '\u{1F1EC}\u{1F1E7}', name: 'UK' },
  { code: 'DE', flag: '\u{1F1E9}\u{1F1EA}', name: 'DE' },
  { code: 'FR', flag: '\u{1F1EB}\u{1F1F7}', name: 'FR' },
  { code: 'ES', flag: '\u{1F1EA}\u{1F1F8}', name: 'ES' },
  { code: 'IT', flag: '\u{1F1EE}\u{1F1F9}', name: 'IT' },
  { code: 'NL', flag: '\u{1F1F3}\u{1F1F1}', name: 'NL' },
  { code: 'IE', flag: '\u{1F1EE}\u{1F1EA}', name: 'IE' },
  { code: 'JP', flag: '\u{1F1EF}\u{1F1F5}', name: 'JP' },
  { code: 'KR', flag: '\u{1F1F0}\u{1F1F7}', name: 'KR' },
  { code: 'IN', flag: '\u{1F1EE}\u{1F1F3}', name: 'IN' },
  { code: 'TH', flag: '\u{1F1F9}\u{1F1ED}', name: 'TH' },
  { code: 'SG', flag: '\u{1F1F8}\u{1F1EC}', name: 'SG' },
  { code: 'HK', flag: '\u{1F1ED}\u{1F1F0}', name: 'HK' },
  { code: 'AU', flag: '\u{1F1E6}\u{1F1FA}', name: 'AU' },
  { code: 'CA', flag: '\u{1F1E8}\u{1F1E6}', name: 'CA' },
  { code: 'MX', flag: '\u{1F1F2}\u{1F1FD}', name: 'MX' },
  { code: 'BR', flag: '\u{1F1E7}\u{1F1F7}', name: 'BR' },
  { code: 'AR', flag: '\u{1F1E6}\u{1F1F7}', name: 'AR' },
  { code: 'CO', flag: '\u{1F1E8}\u{1F1F4}', name: 'CO' },
];

export function ConfirmationCard({
  parsed,
  onTrack,
  onEdit,
  loading,
  actionLabel = 'Show available flights',
  loadingLabel = 'Checking Google Flights...',
  vpnCountries,
  onVpnCountriesChange,
}: {
  parsed: ParsedQuery;
  onTrack: () => void;
  onEdit: () => void;
  loading: boolean;
  actionLabel?: string;
  loadingLabel?: string;
  vpnCountries?: string[];
  onVpnCountriesChange?: (countries: string[]) => void;
}) {
  const [vpnOpen, setVpnOpen] = useState(false);
  const [vpnShowAll, setVpnShowAll] = useState(false);
  const [vpnStatus, setVpnStatus] = useState<{ configured: boolean; sidecarRunning: boolean; ready: boolean } | null>(null);

  useEffect(() => {
    if (!onVpnCountriesChange) return;
    fetch('/api/vpn/status')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setVpnStatus(d.data); })
      .catch(() => {});
  }, [onVpnCountriesChange]);

  const toggleCountry = (code: string) => {
    if (!onVpnCountriesChange || !vpnCountries) return;
    if (vpnCountries.includes(code)) {
      onVpnCountriesChange(vpnCountries.filter((c) => c !== code));
    } else {
      onVpnCountriesChange([...vpnCountries, code]);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.route}>
        <div className={styles.airportGroup}>
          {parsed.origins.map((a) => (
            <div key={a.code} className={styles.airport}>
              <span className={styles.code}>{a.code}</span>
              <span className={styles.city}>{a.name}</span>
            </div>
          ))}
        </div>
        <div className={styles.arrow}>
          {parsed.tripType === 'one_way' ? (
            <svg width="32" height="16" viewBox="0 0 32 16" fill="none">
              <path d="M0 8h28M22 2l6 6-6 6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          ) : (
            <svg width="32" height="16" viewBox="0 0 32 16" fill="none">
              <path d="M0 5h28M22 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
              <path d="M32 11H4M10 15l-4-4 4-4" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </div>
        <div className={styles.airportGroup}>
          {parsed.destinations.map((a) => (
            <div key={a.code} className={styles.airport}>
              <span className={styles.code}>{a.code}</span>
              <span className={styles.city}>{a.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.filters}>
        <span className={styles.tag}>
          {parsed.tripType === 'one_way' ? 'One way' : 'Round trip'}
        </span>
      </div>

      <div className={styles.details}>
        {parsed.outboundDates || parsed.returnDates ? (
          <>
            {parsed.outboundDates && (
              <div className={styles.dateRange}>
                <span className={styles.label}>
                  {parsed.tripType === 'one_way' ? 'Departure' : 'Outbound'}
                </span>
                <span className={styles.value}>
                  {parsed.outboundDates.map(formatDate).join(', ')}
                </span>
              </div>
            )}
            {parsed.returnDates && (
              <div className={styles.dateRange}>
                <span className={styles.label}>Return</span>
                <span className={styles.value}>
                  {parsed.returnDates.map(formatDate).join(', ')}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className={styles.dateRange}>
            <span className={styles.label}>Travel window</span>
            <span className={styles.value}>
              {formatDate(parsed.dateFrom)} &mdash; {formatDate(parsed.dateTo)}
            </span>
          </div>
        )}

        {parsed.flexibility > 0 && (
          <div className={styles.flexibility}>
            <span className={styles.label}>Flexibility</span>
            <span className={styles.value}>&plusmn; {parsed.flexibility} days</span>
          </div>
        )}

        <div className={styles.expiry}>
          <span className={styles.label}>Link expires</span>
          <span className={styles.value}>
            {computeExpiry(parsed.dateTo, parsed.flexibility)}
          </span>
        </div>
      </div>

      <p className={styles.trackingInfo}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        Prices checked daily &middot; Shareable chart &middot; Tracking ends {computeExpiry(parsed.dateTo, parsed.flexibility)}
      </p>

      {hasFilters(parsed) && (
        <div className={styles.filters}>
          {parsed.maxPrice && (
            <span className={styles.tag}>Under {formatCurrency(parsed.maxPrice, parsed.currency ?? 'USD')}</span>
          )}
          {parsed.maxStops !== null && (
            <span className={styles.tag}>
              {parsed.maxStops === 0 ? 'Nonstop only' : `Max ${parsed.maxStops} stop${parsed.maxStops > 1 ? 's' : ''}`}
            </span>
          )}
          {parsed.maxDurationHours !== null && parsed.maxDurationHours > 0 && (
            <span className={styles.tag}>Under {parsed.maxDurationHours}h</span>
          )}
          {parsed.preferredAirlines.length > 0 && (
            <span className={styles.tag}>{parsed.preferredAirlines.join(', ')}</span>
          )}
          {parsed.timePreference !== 'any' && (
            <span className={styles.tag}>{parsed.timePreference}</span>
          )}
          {parsed.cabinClass !== 'economy' && (
            <span className={styles.tag}>{parsed.cabinClass.replace('_', ' ')}</span>
          )}
        </div>
      )}

      {onVpnCountriesChange && (
        <div className={styles.vpnContainer}>
          <button
            className={styles.vpnHeader}
            onClick={() => setVpnOpen(!vpnOpen)}
            type="button"
            aria-expanded={vpnOpen}
          >
            <div className={styles.vpnHeaderLeft}>
              <svg className={styles.vpnGlobe} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
              </svg>
              <span className={styles.vpnTitle}>Global Price Check</span>
              {vpnStatus && (
                <span className={vpnStatus.ready ? styles.vpnStatusReady : styles.vpnStatusOff}>
                  {vpnStatus.ready ? 'VPN ready' : !vpnStatus.configured ? 'Not set up' : 'Sidecar offline'}
                </span>
              )}
              {vpnCountries && vpnCountries.length > 0 && (
                <span className={styles.vpnBadge}>{vpnCountries.length}</span>
              )}
            </div>
            <svg className={`${styles.vpnChevron} ${vpnOpen ? styles.vpnChevronOpen : ''}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {!vpnOpen && (
            <div className={styles.vpnTeaser} onClick={() => setVpnOpen(true)}>
              Does your location affect the price? <span className={styles.vpnHighlight}>Find out.</span>
            </div>
          )}

          {vpnOpen && vpnStatus && !vpnStatus.ready && (
            <div className={styles.vpnPanel}>
              <div className={styles.vpnSetupPrompt}>
                {!vpnStatus.configured ? (
                  <>
                    <p>VPN is not configured yet. Set up ExpressVPN to compare prices from different countries.</p>
                    <a href="/settings" className={styles.vpnSetupLink}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path d="M6.5 1.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v.3a5.5 5.5 0 0 1 1.654.685l.212-.212a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1 0 1.061l-.212.212A5.5 5.5 0 0 1 14 6.5h.25a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75H14a5.5 5.5 0 0 1-.685 1.654l.212.212a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061 0l-.212-.212A5.5 5.5 0 0 1 9.5 14v.25a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75V14a5.5 5.5 0 0 1-1.654-.685l-.212.212a.75.75 0 0 1-1.06 0l-1.061-1.06a.75.75 0 0 1 0-1.061l.212-.212A5.5 5.5 0 0 1 2 9.5h-.25a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75H2a5.5 5.5 0 0 1 .685-1.654l-.212-.212a.75.75 0 0 1 0-1.06l1.06-1.061a.75.75 0 0 1 1.061 0l.212.212A5.5 5.5 0 0 1 6.5 2.05v-.3ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="currentColor" />
                      </svg>
                      Go to Settings
                    </a>
                  </>
                ) : (
                  <>
                    <p>ExpressVPN sidecar is not running. Start Flight Finder with VPN support:</p>
                    <code className={styles.vpnCommand}>docker compose -f docker-compose.prod.yml -f docker-compose.vpn.yml up -d</code>
                  </>
                )}
              </div>
            </div>
          )}

          {vpnOpen && (!vpnStatus || vpnStatus.ready) && (
            <div className={styles.vpnPanel}>
              <div className={styles.vpnChipGrid}>
                {(vpnShowAll ? POPULAR_COUNTRIES : POPULAR_COUNTRIES.slice(0, 12)).map((c) => (
                  <button
                    key={c.code}
                    className={`${styles.vpnChip} ${vpnCountries?.includes(c.code) ? styles.vpnChipActive : ''}`}
                    onClick={() => toggleCountry(c.code)}
                    type="button"
                  >
                    <span>{c.flag}</span>
                    <span className={styles.vpnChipCode}>{c.name}</span>
                  </button>
                ))}
              </div>
              {!vpnShowAll && POPULAR_COUNTRIES.length > 12 && (
                <button className={styles.vpnShowAll} onClick={() => setVpnShowAll(true)} type="button">
                  + {POPULAR_COUNTRIES.length - 12} more regions
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.actions}>
        <button
          className={styles.trackButton}
          onClick={onTrack}
          disabled={loading}
        >
          {loading ? loadingLabel : actionLabel}
        </button>
        <button
          className={styles.editButton}
          onClick={onEdit}
          disabled={loading}
        >
          Edit
        </button>
      </div>
    </div>
  );
}
