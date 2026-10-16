import React from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { renderBrailleChart, type ChartSeries } from '../lib/chart.js';
import { currencySymbol, formatDateShort } from '../lib/format.js';

interface Snapshot {
  price: number;
  currency: string;
  airline: string;
  scrapedAt: Date;
}

interface PriceChartProps {
  snapshots: Snapshot[];
  currency: string;
}

export function PriceChart({ snapshots, currency }: PriceChartProps) {
  const { columns, rows } = useWindowSize();

  const chartWidth = Math.min(columns - 2, 140);
  const chartHeight = Math.max(6, Math.min(Math.floor(rows * 0.35), 16));

  if (snapshots.length === 0) {
    return <Text dimColor>No price data yet — waiting for first scrape.</Text>;
  }

  // Determine visible time window: cap at maxPoints scrape sessions
  // so the chart doesn't get crammed as data accumulates
  const maxPoints = Math.max(10, Math.floor(chartWidth / 4));
  const scrapeTimesSet = new Set(snapshots.map((s) => s.scrapedAt.getTime()));
  const scrapeTimes = [...scrapeTimesSet].sort((a, b) => a - b);
  const cutoffTime = scrapeTimes.length > maxPoints
    ? scrapeTimes[scrapeTimes.length - maxPoints]!
    : 0;

  const visible = cutoffTime > 0
    ? snapshots.filter((s) => s.scrapedAt.getTime() >= cutoffTime)
    : snapshots;

  const byAirline = new Map<string, Array<{ x: number; y: number }>>();
  for (const s of visible) {
    const t = s.scrapedAt.getTime();
    if (!byAirline.has(s.airline)) byAirline.set(s.airline, []);
    byAirline.get(s.airline)!.push({ x: t, y: s.price });
  }

  const series: ChartSeries[] = [];
  for (const [airline, points] of byAirline) {
    series.push({ label: airline, points });
  }

  const allTimes = visible.map((s) => s.scrapedAt.getTime());
  const minT = Math.min(...allTimes);
  const maxT = Math.max(...allTimes);
  const labelCount = Math.min(5, scrapeTimesSet.size);
  const xLabels: string[] = [];
  for (let i = 0; i < labelCount; i++) {
    const t = minT + (i / (labelCount - 1 || 1)) * (maxT - minT);
    xLabels.push(formatDateShort(new Date(t)));
  }

  const chart = renderBrailleChart(series, {
    width: chartWidth,
    height: chartHeight,
    yLabel: currencySymbol(currency),
    xLabels,
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Price Evolution</Text>
      </Box>
      <Text>{chart}</Text>
    </Box>
  );
}
