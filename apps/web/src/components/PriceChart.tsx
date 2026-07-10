'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { formatCurrency } from '@/lib/currency';
import { safeHttpUrl } from '@/lib/safe-url';
import styles from './PriceChart.module.css';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

interface Snapshot {
  id: string;
  travelDate: string;
  price: number;
  currency: string;
  airline: string;
  bookingUrl: string | null;
  stops: number;
  duration: string | null;
  flightId: string | null;
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

function buildDetailTraces(snapshots: Snapshot[], currency: string, hasVpnData: boolean) {
  const available = snapshots.filter((s) => s.status !== 'sold_out');
  const soldOut = snapshots.filter((s) => s.status === 'sold_out');

  const byGroup = new Map<string, Snapshot[]>();
  for (const s of available) {
    const key = hasVpnData && s.vpnCountry ? `${s.airline} (${s.vpnCountry})` : s.airline;
    const existing = byGroup.get(key) ?? [];
    existing.push(s);
    byGroup.set(key, existing);
  }

  let idx = 0;
  const result = Array.from(byGroup.entries()).map(([group, points]) => {
    const baseAirline = points[0]?.airline ?? group;
    const color = getAirlineColor(baseAirline, idx++);
    return {
      x: points.map((p) => p.scrapedAt),
      y: points.map((p) => p.price),
      type: 'scatter' as const,
      mode: 'lines+markers' as const,
      name: group,
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
        if (p.seatsLeft) lines.push(`${p.seatsLeft} seats left`);
        if (p.vpnCountry) lines.push(`${countryFlag(p.vpnCountry)} Scraped from ${p.vpnCountry}`);
        return lines.join('<br>');
      }),
      hovertemplate: '%{text}<extra>%{fullData.name}</extra>',
    };
  });

  if (soldOut.length > 0) {
    result.push({
      x: soldOut.map((p) => p.scrapedAt),
      y: soldOut.map((p) => p.price),
      type: 'scatter' as const,
      mode: 'lines+markers' as const,
      name: 'Sold out',
      line: { color: '#ef4444', width: 0 },
      marker: { color: '#ef4444', size: 10 },
      customdata: soldOut.map((p) => [p.bookingUrl]),
      text: soldOut.map((p) => {
        const lines = [
          `<b>${formatCurrency(p.price, p.currency ?? currency)}</b> (sold out)`,
          new Date(p.scrapedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        ];
        if (p.departureTime || p.arrivalTime) {
          lines.push(`${p.departureTime ?? '?'} - ${p.arrivalTime ?? '?'}`);
        }
        return lines.join('<br>');
      }),
      hovertemplate: '%{text}<extra>Sold out</extra>',
    });
  }

  return result;
}

/** Comparison view: one line per country showing the cheapest price at each scrape time */
function buildComparisonTraces(snapshots: Snapshot[], currency: string) {
  const available = snapshots.filter((s) => s.status !== 'sold_out');

  // Group by country label
  const byCountry = new Map<string, Snapshot[]>();
  for (const s of available) {
    const label = s.vpnCountry ?? 'Local';
    const existing = byCountry.get(label) ?? [];
    existing.push(s);
    byCountry.set(label, existing);
  }

  let idx = 0;
  return Array.from(byCountry.entries()).map(([label, points]) => {
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
    idx++;

    return {
      x: cheapest.map((p) => p.scrapedAt),
      y: cheapest.map((p) => p.price),
      type: 'scatter' as const,
      mode: 'lines+markers' as const,
      name: `${flag}${label}`,
      line: { color, width: 3 },
      marker: { color, size: 8 },
      customdata: cheapest.map((p) => [p.bookingUrl]),
      text: cheapest.map((p) => {
        const lines = [
          `<b>${formatCurrency(p.price, p.currency ?? currency)}</b> cheapest from ${flag}${label}`,
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
}

export function PriceChart({ snapshots, allSnapshots, editEvents = [], currency = 'USD' }: Props) {
  const plotTheme = usePlotTheme();
  const fullHistory = allSnapshots ?? snapshots;
  const hasFilteredHistory = fullHistory.length !== snapshots.length;
  const [historyMode, setHistoryMode] = useState<HistoryMode>('current');
  const historySnapshots = historyMode === 'all' ? fullHistory : snapshots;

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
      return buildComparisonTraces(filteredSnapshots, currency);
    }
    return buildDetailTraces(filteredSnapshots, currency, hasVpnData && view === 'all');
  }, [filteredSnapshots, currency, view, hasVpnData]);

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
    text: index === editEvents.length - 1 ? event.summary : 'Edited',
    showarrow: false,
    xanchor: 'left' as const,
    yanchor: 'bottom' as const,
    yshift: 4,
    font: { family: 'IBM Plex Mono, monospace', color: plotTheme.accent, size: 10 },
    bgcolor: plotTheme.surface,
    bordercolor: plotTheme.accent,
    borderwidth: 1,
    borderpad: 3,
  })), [editEvents, plotTheme.accent, plotTheme.surface]);

  const controls = (
    <>
      {hasFilteredHistory && (
        <div className={styles.historyFilter}>
          <button
            className={`${styles.historyOption} ${historyMode === 'current' ? styles.historyOptionActive : ''}`}
            onClick={() => setHistoryMode('current')}
            type="button"
          >
            Current filters
          </button>
          <button
            className={`${styles.historyOption} ${historyMode === 'all' ? styles.historyOptionActive : ''}`}
            onClick={() => setHistoryMode('all')}
            type="button"
          >
            All history
          </button>
        </div>
      )}
      {hasVpnData && (
        <div className={styles.viewFilter}>
          <select
            className={styles.viewSelect}
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            <option value="all">All countries</option>
            <option value="comparison">Country comparison (cheapest)</option>
            <option value="local">Local only</option>
            {vpnCountries.map((code) => (
              <option key={code} value={code}>
                {countryFlag(code)} {code} only
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
  const hasControls = hasFilteredHistory || hasVpnData;

  if (fullHistory.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>No price data yet</p>
        <p className={styles.emptyHint}>
          Prices will appear after the first scrape runs. Check back soon.
        </p>
      </div>
    );
  }

  if (filteredSnapshots.length === 0) {
    return (
      <div className={styles.root}>
        {hasControls && <div className={styles.controls}>{controls}</div>}
        <div className={styles.empty}>
          <p className={styles.emptyText}>No price data for this view</p>
          <p className={styles.emptyHint}>
            Switch views or wait for the next scrape to collect prices under the current filters.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {hasControls && <div className={styles.controls}>{controls}</div>}
      <Plot
        data={traces}
        layout={{
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { family: 'IBM Plex Mono, monospace', color: plotTheme.axisText, size: 11 },
          margin: { t: 20, r: 20, b: 50, l: 60 },
          xaxis: {
            gridcolor: plotTheme.grid,
            tickformat: '%b %d %H:%M',
            title: { text: '' },
          },
          yaxis: {
            gridcolor: plotTheme.grid,
            title: { text: currency },
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
        style={{ width: '100%', height: '400px' }}
        onClick={(data) => {
          const point = data.points[0];
          if (point?.customdata) {
            const url = safeHttpUrl((point.customdata as string[])[0]);
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
          }
        }}
      />
    </div>
  );
}
