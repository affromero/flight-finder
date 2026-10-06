'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { formatCurrency } from '@/lib/currency';
import { clickedBookingUrl } from '@/lib/chart/booking';
import { airTimeMinutes, formatMinutes, layoverLabel } from '@/lib/scraper/duration';
import { flightVisibilityKey, flightSeriesKey, chartTraceUid } from '@/lib/chart/identity';
import { useTrackerChartView } from '@/lib/chart/view';
import { localAxisTicks, chartRangeChange } from '@/lib/chart/axis';
import styles from './PriceChart.module.css';

const Plot = dynamic(async () => {
  const [{ default: createPlot }, { default: plotly }] = await Promise.all([
    import('react-plotly.js/factory'),
    import('plotly.js'),
  ]);
  return createPlot(plotly);
}, { ssr: false });

interface Snapshot {
  id: string;
  travelDate: string;
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  duration: string | null;
  layovers?: unknown;
  flightId: string | null;
  flightNumber?: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  seatsLeft: number | null;
  status: string;
  airlineDirectPrice: number | null;
  vpnCountry: string | null;
  scrapedAt: string;
}

type ChartView = 'all' | 'local' | 'comparison' | string; // string = specific country code
type HistoryMode = 'current' | 'all';
type Translator = ReturnType<typeof useTranslations>;

interface PlotTheme {
  axisText: string;
  grid: string;
  accent: string;
  surface: string;
  text: string;
}

interface EditEvent {
  id: string;
  editedAt: string;
  summary: string;
}

const DEFAULT_PLOT_THEME: PlotTheme = {
  axisText: '#8b9ec2',
  grid: '#243049',
  accent: '#80a8a5',
  surface: '#0e3640',
  text: '#ecdfc0',
};

const AIRLINE_COLORS: Record<string, string> = {
  Delta: '#e31837',
  United: '#002244',
  American: '#0078d2',
  'Air France': '#002157',
  Southwest: '#ffbf27',
  JetBlue: '#003876',
  Spirit: '#ffe600',
  Alaska: '#01426a',
  British: '#2e5c99',
  Lufthansa: '#05164d',
  Emirates: '#d71a21',
  KLM: '#00a1de',
};

const COUNTRY_COLORS = ['#80a8a5', '#c1272d', '#d4a574', '#8b5cf6', '#ec4899', '#14b8a6', '#3b82f6', '#f97316'];

function countryFlag(code: string): string {
  return String.fromCodePoint(...code.split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function getAirlineColor(airline: string, index: number): string {
  for (const [key, color] of Object.entries(AIRLINE_COLORS)) {
    if (airline.toLowerCase().includes(key.toLowerCase())) return color;
  }
  const fallback = ['#80a8a5', '#c1272d', '#d4a574', '#8b5cf6', '#ec4899', '#14b8a6', '#3b82f6', '#f97316'];
  return fallback[index % fallback.length]!;
}

function readCssVariable(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function readPlotTheme(): PlotTheme {
  if (typeof window === 'undefined') return DEFAULT_PLOT_THEME;
  const styles = getComputedStyle(document.documentElement);
  return {
    axisText: readCssVariable(styles, '--muted', DEFAULT_PLOT_THEME.axisText),
    grid: readCssVariable(styles, '--border', DEFAULT_PLOT_THEME.grid),
    accent: readCssVariable(styles, '--accent', DEFAULT_PLOT_THEME.accent),
    surface: readCssVariable(styles, '--elevated', DEFAULT_PLOT_THEME.surface),
    text: readCssVariable(styles, '--text', DEFAULT_PLOT_THEME.text),
  };
}

function usePlotTheme(): PlotTheme {
  const [plotTheme, setPlotTheme] = useState(DEFAULT_PLOT_THEME);

  useEffect(() => {
    const updateTheme = () => setPlotTheme(readPlotTheme());
    updateTheme();

    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    media?.addEventListener('change', updateTheme);

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(updateTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-theme-mode'],
      });
    }

    return () => {
      media?.removeEventListener('change', updateTheme);
      observer?.disconnect();
    };
  }, []);

  return plotTheme;
}

function flightLabel(snapshot: Snapshot, hasVpnData: boolean, mixedCurrencies: boolean, t: Translator): string {
  return [
    snapshot.airline, snapshot.flightNumber, snapshot.travelDate.slice(0, 10), snapshot.departureTime ?? '?',
    mixedCurrencies ? `(${snapshot.currency})` : null,
    hasVpnData ? `(${snapshot.vpnCountry ?? t('local')})` : null,
  ].filter(Boolean).join(' ');
}

function buildDetailTraces(snapshots: Snapshot[], currency: string, hasVpnData: boolean, t: Translator, byFlight: boolean, hidden: string[]) {
  const available = snapshots.filter((s) => s.status !== 'sold_out');
  const soldOut = snapshots.filter((s) => s.status === 'sold_out');
  const mixedCurrencies = new Set(snapshots.map(snapshot => snapshot.currency)).size > 1;

  const byGroup = new Map<string, Snapshot[]>();
  for (const s of available) {
    const carrier = `${s.airline}${mixedCurrencies ? ` (${s.currency})` : ''}`;
    const key = byFlight ? flightSeriesKey(s) : hasVpnData && s.vpnCountry ? `${carrier} (${s.vpnCountry})` : carrier;
    const existing = byGroup.get(key) ?? [];
    existing.push(s);
    byGroup.set(key, existing);
  }

  let idx = 0;
  const result = Array.from(byGroup.entries()).map(([group, unsortedPoints]) => {
    const points = [...unsortedPoints].sort((a, b) => a.scrapedAt.localeCompare(b.scrapedAt));
    const first = points[0]!;
    const baseAirline = points[0]?.airline ?? group;
    const colorIndex = [...group].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0);
    const color = byFlight ? COUNTRY_COLORS[colorIndex % COUNTRY_COLORS.length]! : getAirlineColor(baseAirline, idx++);
    const label = byFlight ? flightLabel(first, hasVpnData, mixedCurrencies, t) : group;
    return {
      x: points.map((p) => p.scrapedAt),
      y: points.map((p) => p.price),
      type: 'scatter' as const,
      mode: 'lines+markers' as const,
      name: label,
      uid: chartTraceUid(`detail:${group}`),
      meta: byFlight ? flightVisibilityKey(first) : undefined,
      visible: byFlight && hidden.includes(flightVisibilityKey(first)) ? 'legendonly' as const : true,
      line: { color, width: 2 },
      marker: { color, size: 6 },
      customdata: points.map((p) => [p.bookingUrl]),
      text: points.map((p) => {
        const lines = [
          `<b>${formatCurrency(p.price, p.currency ?? currency)}</b>`,
          new Date(p.scrapedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        ];
        if (p.departureTime || p.arrivalTime) {
          lines.push(`${p.departureTime ?? '?'} - ${p.arrivalTime ?? '?'}`);
        }
        if (p.duration) lines.push(p.duration);
        const layover = layoverLabel(p.layovers);
        if (layover) lines.push(t('layover', { time: layover }));
        const air = airTimeMinutes(p.duration, p.layovers);
        if (air !== null) lines.push(t('airTime', { time: formatMinutes(air) }));
        if (p.seatsLeft) lines.push(t('seatsLeft', { count: p.seatsLeft }));
        if (p.vpnCountry) lines.push(`${countryFlag(p.vpnCountry)} ${t('scrapedFrom', { country: p.vpnCountry })}`);
        return lines.join('<br>');
      }),
      hovertemplate: '%{text}<extra>%{fullData.name}</extra>',
    };
  });

  const soldOutGroups = new Map<string, Snapshot[]>();
  for (const snapshot of soldOut) {
    const key = byFlight ? flightSeriesKey(snapshot) : 'sold-out';
    const points = soldOutGroups.get(key) ?? [];
    points.push(snapshot);
    soldOutGroups.set(key, points);
  }
  for (const [key, unsortedPoints] of soldOutGroups) {
    const points = [...unsortedPoints].sort((a, b) => a.scrapedAt.localeCompare(b.scrapedAt));
    const first = points[0]!;
    result.push({
      x: points.map((p) => p.scrapedAt),
      y: points.map((p) => p.price),
      type: 'scatter' as const,
      mode: 'lines+markers' as const,
      name: byFlight ? `${flightLabel(first, hasVpnData, mixedCurrencies, t)} (${t('soldOut')})` : t('soldOut'),
      uid: chartTraceUid(`sold-out:${key}`),
      meta: byFlight ? flightVisibilityKey(first) : undefined,
      visible: byFlight && hidden.includes(flightVisibilityKey(first)) ? 'legendonly' as const : true,
      line: { color: '#ef4444', width: 0 },
      marker: { color: '#ef4444', size: 10 },
      customdata: points.map(() => [null]),
      text: points.map((p) => {
        const lines = [
          `<b>${formatCurrency(p.price, p.currency ?? currency)}</b> ${t('soldOutSuffix')}`,
          new Date(p.scrapedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        ];
        if (p.departureTime || p.arrivalTime) {
          lines.push(`${p.departureTime ?? '?'} - ${p.arrivalTime ?? '?'}`);
        }
        return lines.join('<br>');
      }),
      hovertemplate: `%{text}<extra>${t('soldOut')}</extra>`,
    });
  }

  return result;
}

/** Comparison view: one line per country showing the cheapest price at each scrape time */
function buildComparisonTraces(snapshots: Snapshot[], currency: string, t: Translator) {
  const available = snapshots.filter((s) => s.status !== 'sold_out');
  const mixedCurrencies = new Set(available.map(snapshot => snapshot.currency)).size > 1;

  // Group by country label
  const byCountry = new Map<string, Snapshot[]>();
  for (const s of available) {
    const key = JSON.stringify([s.vpnCountry, s.currency]);
    const existing = byCountry.get(key) ?? [];
    existing.push(s);
    byCountry.set(key, existing);
  }

  let idx = 0;
  return Array.from(byCountry.entries()).map(([key, points]) => {
    const label = points[0]!.vpnCountry ?? 'Local';
    // Group by scrapedAt timestamp (rounded to minute) and pick cheapest
    const byTime = new Map<string, Snapshot>();
    for (const p of points) {
      const timeKey = p.scrapedAt.slice(0, 16); // YYYY-MM-DDTHH:MM
      const existing = byTime.get(timeKey);
      if (!existing || p.price < existing.price) {
        byTime.set(timeKey, p);
      }
    }

    const cheapest = Array.from(byTime.values()).sort(
      (a, b) => new Date(a.scrapedAt).getTime() - new Date(b.scrapedAt).getTime()
    );

    const color = COUNTRY_COLORS[idx % COUNTRY_COLORS.length]!;
    const flag = label !== 'Local' ? countryFlag(label) + ' ' : '';
    const displayLabel = label === 'Local' ? t('local') : label;
    idx++;

    return {
      x: cheapest.map((p) => p.scrapedAt),
      y: cheapest.map((p) => p.price),
      type: 'scatter' as const,
      mode: 'lines+markers' as const,
      name: `${flag}${displayLabel}${mixedCurrencies ? ` (${points[0]!.currency})` : ''}`,
      uid: chartTraceUid(`country:${key}`),
      meta: undefined,
      line: { color, width: 3 },
      marker: { color, size: 8 },
      customdata: cheapest.map((p) => [p.bookingUrl]),
      text: cheapest.map((p) => {
        const lines = [
          `<b>${formatCurrency(p.price, p.currency ?? currency)}</b> ${t('cheapestFrom', { location: `${flag}${displayLabel}` })}`,
          `${p.airline}`,
          new Date(p.scrapedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        ];
        return lines.join('<br>');
      }),
      hovertemplate: '%{text}<extra>%{fullData.name}</extra>',
    };
  });
}

interface Props {
  snapshots: Snapshot[];
  allSnapshots?: Snapshot[];
  editEvents?: EditEvent[];
  currency?: string;
  trackerId?: string;
}

export function PriceChart({ snapshots, allSnapshots, editEvents = [], currency = 'USD', trackerId }: Props) {
  const t = useTranslations('PriceChart');
  const plotTheme = usePlotTheme();
  const fullHistory = allSnapshots ?? snapshots;
  const hasFilteredHistory = fullHistory.length !== snapshots.length;
  const [historyMode, setHistoryMode] = useState<HistoryMode>('current');
  const historySnapshots = historyMode === 'all' ? fullHistory : snapshots;
  const chartView = useTrackerChartView(trackerId);
  const [plotError, setPlotError] = useState<string | null>(null);
  const [axisState, setAxisState] = useState<{ trackerId?: string; range: [number, number] | null }>({ trackerId, range: null });
  const axisRange = axisState.trackerId === trackerId ? axisState.range : null;

  // Detect VPN data and available countries
  const vpnCountries = useMemo(() => {
    const countries = new Set<string>();
    for (const s of historySnapshots) {
      if (s.vpnCountry) countries.add(s.vpnCountry);
    }
    return Array.from(countries).sort();
  }, [historySnapshots]);

  const hasVpnData = vpnCountries.length > 0;
  const [view, setView] = useState<ChartView>('all');

  // Filter snapshots based on selected view
  const filteredSnapshots = useMemo(() => {
    if (view === 'all') return historySnapshots;
    if (view === 'local') return historySnapshots.filter((s) => !s.vpnCountry);
    if (view === 'comparison') return historySnapshots; // comparison uses all data but builds different traces
    // Specific country code
    return historySnapshots.filter((s) => s.vpnCountry === view);
  }, [historySnapshots, view]);

  const traces = useMemo(() => {
    if (view === 'comparison') {
      const visible = chartView.grouping === 'flight' ? filteredSnapshots.filter(snapshot => !chartView.hidden.includes(flightVisibilityKey(snapshot))) : filteredSnapshots;
      return buildComparisonTraces(visible, currency, t);
    }
    return buildDetailTraces(filteredSnapshots, currency, hasVpnData && view === 'all', t, chartView.grouping === 'flight', chartView.hidden);
  }, [filteredSnapshots, currency, view, hasVpnData, t, chartView.grouping, chartView.hidden]);
  const axisTicks = useMemo(() => localAxisTicks([
    ...filteredSnapshots.map(snapshot => snapshot.scrapedAt), ...editEvents.map(event => event.editedAt),
  ], axisRange), [filteredSnapshots, editEvents, axisRange]);

  const editShapes = useMemo(() => editEvents.map((event) => ({
    type: 'line' as const,
    xref: 'x' as const,
    yref: 'paper' as const,
    x0: event.editedAt,
    x1: event.editedAt,
    y0: 0,
    y1: 1,
    line: { color: plotTheme.accent, width: 1, dash: 'dot' as const },
  })), [editEvents, plotTheme.accent]);

  const editAnnotations = useMemo(() => editEvents.map((event, index) => ({
    x: event.editedAt,
    y: 1,
    xref: 'x' as const,
    yref: 'paper' as const,
    text: index === editEvents.length - 1 ? event.summary : t('edited'),
    showarrow: false,
    xanchor: 'left' as const,
    yanchor: 'bottom' as const,
    yshift: 4,
    font: { family: 'IBM Plex Mono, monospace', color: plotTheme.accent, size: 10 },
    bgcolor: plotTheme.surface,
    bordercolor: plotTheme.accent,
    borderwidth: 1,
    borderpad: 3,
  })), [editEvents, plotTheme.accent, plotTheme.surface, t]);

  const controls = (
    <>
      <div className={styles.viewFilter}>
        <label className={styles.groupingLabel}>
          {t('groupBy')}
          <select className={styles.viewSelect} value={chartView.grouping} onChange={event => chartView.setGrouping(event.target.value === 'flight' ? 'flight' : 'airline')}>
            <option value="airline">{t('byAirline')}</option>
            <option value="flight">{t('byFlight')}</option>
          </select>
        </label>
        {chartView.grouping === 'flight' && chartView.hidden.length > 0 && (
          <button type="button" className={styles.historyOption} onClick={chartView.showAll}>{t('showAllFlights')}</button>
        )}
      </div>
      {hasFilteredHistory && (
        <div className={styles.historyFilter}>
          <button
            className={`${styles.historyOption} ${historyMode === 'current' ? styles.historyOptionActive : ''}`}
            onClick={() => setHistoryMode('current')}
            type="button"
          >
            {t('currentFilters')}
          </button>
          <button
            className={`${styles.historyOption} ${historyMode === 'all' ? styles.historyOptionActive : ''}`}
            onClick={() => setHistoryMode('all')}
            type="button"
          >
            {t('allHistory')}
          </button>
        </div>
      )}
      {hasVpnData && (
        <div className={styles.viewFilter}>
          <select
            className={styles.viewSelect}
            aria-label={t('countryView')}
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            <option value="all">{t('allCountries')}</option>
            <option value="comparison">{t('countryComparison')}</option>
            <option value="local">{t('localOnly')}</option>
            {vpnCountries.map((code) => (
              <option key={code} value={code}>
                {countryFlag(code)} {t('countryOnly', { country: code })}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
  const hasControls = fullHistory.length > 0;

  if (fullHistory.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>{t('noPriceData')}</p>
        <p className={styles.emptyHint}>
          {t('noPriceDataHint')}
        </p>
      </div>
    );
  }

  if (filteredSnapshots.length === 0) {
    return (
      <div className={styles.root}>
        {hasControls && <div className={styles.controls}>{controls}</div>}
        <div className={styles.empty}>
          <p className={styles.emptyText}>{t('noViewData')}</p>
          <p className={styles.emptyHint}>
            {t('noViewDataHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {hasControls && <div className={styles.controls}>{controls}</div>}
      {plotError && <p role="alert" className={styles.plotError}>{t('plotError', { message: plotError })}</p>}
      <Plot
        className={styles.plot}
        data={traces}
        layout={{
          uirevision: trackerId ?? 'chart',
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { family: 'IBM Plex Mono, monospace', color: plotTheme.axisText, size: 11 },
          margin: { t: 20, r: 20, b: 50, l: 60 },
          xaxis: {
            type: 'date',
            gridcolor: plotTheme.grid,
            tickmode: 'array',
            ...axisTicks,
            title: { text: '' },
          },
          yaxis: {
            gridcolor: plotTheme.grid,
            title: { text: new Set(filteredSnapshots.map(snapshot => snapshot.currency)).size > 1 ? t('price') : filteredSnapshots[0]?.currency ?? currency },
          },
          legend: {
            orientation: 'h',
            y: -0.15,
            font: { size: 11 },
          },
          shapes: editShapes,
          annotations: editAnnotations,
          // Opaque hover box. The unified label otherwise inherits the
          // transparent paper_bgcolor, so the x axis date ticks bled through
          // it into unreadable text-on-text when hovering a low point (#97).
          // A solid surface cleanly occludes whatever sits behind the box.
          hoverlabel: {
            bgcolor: plotTheme.surface,
            bordercolor: plotTheme.accent,
            font: { family: 'IBM Plex Mono, monospace', color: plotTheme.text, size: 11 },
            align: 'left',
          },
          hovermode: 'x unified',
          autosize: true,
        }}
        config={{
          responsive: true,
          displayModeBar: false,
        }}
        onError={error => setPlotError(error instanceof Error ? error.message : String(error))}
        onUpdate={() => setPlotError(null)}
        onRelayout={event => {
          const range = chartRangeChange(event);
          if (range !== undefined) setAxisState({ trackerId, range });
        }}
        onLegendClick={event => {
          if (chartView.grouping !== 'flight' || view === 'comparison') return true;
          const key = traces[event.curveNumber]?.meta;
          if (typeof key === 'string') chartView.toggle(key);
          return false;
        }}
        onLegendDoubleClick={event => {
          if (chartView.grouping !== 'flight' || view === 'comparison') return true;
          const key = traces[event.curveNumber]?.meta;
          if (typeof key === 'string') chartView.isolate(key, fullHistory.map(flightVisibilityKey));
          return false;
        }}
        onClick={(data) => {
          const url = clickedBookingUrl(data);
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        }}
      />
    </div>
  );
}
