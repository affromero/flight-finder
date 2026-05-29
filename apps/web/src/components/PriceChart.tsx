'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { currencySymbol } from '@/lib/currency';
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

function buildDetailTraces(snapshots: Snapshot[], sym: string, hasVpnData: boolean) {
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
          `<b>${sym}${p.price.toFixed(2)}</b> ${p.currency}`,
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
          `<b>${sym}${p.price.toFixed(2)}</b> (sold out)`,
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
function buildComparisonTraces(snapshots: Snapshot[], sym: string) {
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
          `<b>${sym}${p.price.toFixed(2)}</b> cheapest from ${flag}${label}`,
          `${p.airline}`,
          new Date(p.scrapedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        ];
        return lines.join('<br>');
      }),
      hovertemplate: '%{text}<extra>%{fullData.name}</extra>',
    };
  });
}

export function PriceChart({ snapshots, currency = 'USD' }: { snapshots: Snapshot[]; currency?: string }) {
  const sym = currencySymbol(currency);

  // Detect VPN data and available countries
  const vpnCountries = useMemo(() => {
    const countries = new Set<string>();
    for (const s of snapshots) {
      if (s.vpnCountry) countries.add(s.vpnCountry);
    }
    return Array.from(countries).sort();
  }, [snapshots]);

  const hasVpnData = vpnCountries.length > 0;
  const [view, setView] = useState<ChartView>('all');

  // Filter snapshots based on selected view
  const filteredSnapshots = useMemo(() => {
    if (view === 'all') return snapshots;
    if (view === 'local') return snapshots.filter((s) => !s.vpnCountry);
    if (view === 'comparison') return snapshots; // comparison uses all data but builds different traces
    // Specific country code
    return snapshots.filter((s) => s.vpnCountry === view);
  }, [snapshots, view]);

  const traces = useMemo(() => {
    if (view === 'comparison') {
      return buildComparisonTraces(filteredSnapshots, sym);
    }
    return buildDetailTraces(filteredSnapshots, sym, hasVpnData && view === 'all');
  }, [filteredSnapshots, sym, view, hasVpnData]);

  if (snapshots.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>No price data yet</p>
        <p className={styles.emptyHint}>
          Prices will appear after the first scrape runs. Check back soon.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
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
      <Plot
        data={traces}
        layout={{
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { family: 'IBM Plex Mono, monospace', color: '#8b9ec2', size: 11 },
          margin: { t: 20, r: 20, b: 50, l: 60 },
          xaxis: {
            gridcolor: '#243049',
            tickformat: '%b %d %H:%M',
            title: { text: '' },
          },
          yaxis: {
            gridcolor: '#243049',
            tickprefix: sym,
            title: { text: '' },
          },
          legend: {
            orientation: 'h',
            y: -0.15,
            font: { size: 11 },
          },
          // Opaque hover box. The unified label otherwise inherits the
          // transparent paper_bgcolor, so the x axis date ticks bled through
          // it into unreadable text-on-text when hovering a low point (#97).
          // A solid surface cleanly occludes whatever sits behind the box.
          hoverlabel: {
            bgcolor: '#0e3640',
            bordercolor: '#80a8a5',
            font: { family: 'IBM Plex Mono, monospace', color: '#ecdfc0', size: 11 },
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
            const url = (point.customdata as string[])[0];
            if (url) window.open(url, '_blank');
          }
        }}
      />
    </div>
  );
}
