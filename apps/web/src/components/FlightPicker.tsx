'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PriceData } from '@/lib/scraper/extract-prices';
import { formatCurrency } from '@/lib/currency';
import styles from './FlightPicker.module.css';

export interface RouteFlights {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  flights: PriceData[];
  date?: string; // ISO date — outbound date when grouped by travel date
  returnDate?: string; // ISO date — return date for round trips
  error?: string;
}

function formatRouteDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function rKey(route: RouteFlights): string {
  return `${route.origin}-${route.destination}${route.date ? '-' + route.date : ''}`;
}

export function FlightPicker({
  routes,
  onTrack,
  onBack,
  onEdit,
  loading,
  maxSelectionsPerRoute = 10,
}: {
  routes: RouteFlights[];
  onTrack: (routeSelections: Array<{ route: RouteFlights; flights: PriceData[] }>) => void;
  onBack: () => void;
  onEdit: () => void;
  loading: boolean;
  // Admin-configurable cap (ExtractionConfig.maxTrackedPerRoute). Also bounded in
  // practice by route.flights.length, since you can only pick extracted flights.
  maxSelectionsPerRoute?: number;
}) {
  const t = useTranslations('FlightPicker');
  const [selections, setSelections] = useState<Record<string, Set<number>>>(() => {
    const initial: Record<string, Set<number>> = {};
    for (const route of routes) {
      if (route.flights.length > 0) {
        initial[rKey(route)] = new Set(
          route.flights.slice(0, maxSelectionsPerRoute).map((_, i) => i)
        );
      }
    }
    return initial;
  });

  const toggle = (key: string, index: number) => {
    setSelections((prev) => {
      const current = new Set(prev[key] ?? []);
      if (current.has(index)) {
        current.delete(index);
      } else if (current.size < maxSelectionsPerRoute) {
        current.add(index);
      }
      return { ...prev, [key]: current };
    });
  };

  const selectAll = (key: string, flights: PriceData[]) => {
    const indices = flights.slice(0, maxSelectionsPerRoute).map((_, i) => i);
    setSelections((prev) => ({ ...prev, [key]: new Set(indices) }));
  };

  const clearAll = (key: string) => {
    setSelections((prev) => ({ ...prev, [key]: new Set() }));
  };

  const totalSelected = Object.values(selections).reduce((sum, s) => sum + s.size, 0);

  const handleTrack = () => {
    const result: Array<{ route: RouteFlights; flights: PriceData[] }> = [];
    for (const route of routes) {
      const selected = selections[rKey(route)];
      if (selected && selected.size > 0) {
        result.push({
          route,
          flights: route.flights.filter((_, i) => selected.has(i)),
        });
      }
    }
    onTrack(result);
  };

  const routesWithFlights = routes.filter((r) => r.flights.length > 0);
  const isSingleRoute = routesWithFlights.length === 1;

  return (
    <div className={styles.root}>
      {routesWithFlights.map((route) => {
        const key = rKey(route);
        const selected = selections[key] ?? new Set<number>();

        return (
          <div key={key} className={styles.routeSection}>
            <div className={styles.header}>
              <div className={styles.headerLeft}>
                {!isSingleRoute && (
                  <span className={styles.routeLabel}>
                    {route.origin} → {route.destination}
                    {route.date && ` · ${formatRouteDate(route.date)}`}
                  </span>
                )}
                <h3 className={styles.title}>
                  {isSingleRoute
                    ? route.date ? t('flightsOn', { date: formatRouteDate(route.date) }) : t('availableFlights')
                    : route.destinationName}
                </h3>
                <span className={styles.counter}>
                  {t('selectedCount', { selected: selected.size, total: Math.min(route.flights.length, maxSelectionsPerRoute) })}
                </span>
              </div>
              <div className={styles.headerActions}>
                <button className={styles.selectAction} onClick={() => selectAll(key, route.flights)} disabled={loading}>
                  {t('selectAll')}
                </button>
                <button className={styles.selectAction} onClick={() => clearAll(key)} disabled={loading || selected.size === 0}>
                  {t('clear')}
                </button>
              </div>
            </div>

            {isSingleRoute && (
              <p className={styles.hint}>{t('hint', { count: maxSelectionsPerRoute })}</p>
            )}

            <div className={styles.list}>
              {route.flights.map((flight, i) => {
                const isSelected = selected.has(i);
                const isDisabled = !isSelected && selected.size >= maxSelectionsPerRoute;

                return (
                  <button
                    key={i}
                    className={`${styles.row} ${isSelected ? styles.rowSelected : ''} ${isDisabled ? styles.rowDisabled : ''}`}
                    onClick={() => toggle(key, i)}
                    disabled={loading || isDisabled}
                    type="button"
                  >
                    <div className={styles.checkbox}>
                      {isSelected && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <path d="M5 12l5 5L20 7" />
                        </svg>
                      )}
                    </div>
                    <div className={styles.airline}>{flight.airline}</div>
                    <div className={styles.price}>{formatCurrency(flight.price, flight.currency)}</div>
                    <div className={styles.meta}>
                      <span className={styles.stops}>{flight.stops === 0 ? t('nonstop') : t('stops', { count: flight.stops })}</span>
                      {flight.duration && (
                        <span className={styles.duration}>{flight.duration}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {routes.some((r) => r.error) && (
        <div className={styles.routeErrors}>
          {routes.filter((r) => r.error).map((r) => (
            <p key={rKey(r)} className={styles.routeError}>
              {r.origin} → {r.destination}: {r.error}
            </p>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        <button
          className={styles.trackButton}
          onClick={handleTrack}
          disabled={loading || totalSelected === 0}
        >
          {loading ? t('creatingTrackers') : t('trackFlights', { count: totalSelected })}
        </button>
        <button className={styles.backButton} onClick={onBack} disabled={loading}>
          {t('back')}
        </button>
        <button className={styles.backButton} onClick={onEdit} disabled={loading}>
          {t('editSearch')}
        </button>
      </div>
    </div>
  );
}
