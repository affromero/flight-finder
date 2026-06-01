import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { prisma } from '@/lib/prisma';
import { PriceChart } from '../components/PriceChart.js';
import { BestPriceCard } from '../components/BestPriceCard.js';
import { formatDate, formatCurrency, formatStops, formatTimeAgo } from '../lib/format.js';

const REFRESH_INTERVAL = 30; // seconds

interface Snapshot {
  id: string;
  price: number;
  currency: string;
  airline: string;
  stops: number;
  duration: string | null;
  bookingUrl: string | null;
  travelDate: Date;
  scrapedAt: Date;
  status: string;
}

interface QueryData {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  dateFrom: Date;
  dateTo: Date;
  currency: string | null;
  active: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  snapshots: Snapshot[];
  lastScraped: Date | null;
}

// Isolated countdown — only this re-renders every second
function CountdownBar({ refreshing, onRefresh, snapshotCount, lastScraped }: {
  refreshing: boolean;
  onRefresh: () => void;
  snapshotCount: number;
  lastScraped: Date | null;
}) {
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);

  useEffect(() => {
    if (refreshing) {
      setCountdown(REFRESH_INTERVAL);
      return;
    }
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          onRefresh();
          return REFRESH_INTERVAL;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refreshing, onRefresh]);

  const barWidth = 20;
  const filled = Math.round(((REFRESH_INTERVAL - countdown) / REFRESH_INTERVAL) * barWidth);
  const countdownBar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  return (
    <Box flexDirection="row">
      {refreshing ? (
        <Box>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>{' '}Refreshing...</Text>
        </Box>
      ) : (
        <Box>
          <Text dimColor>Next refresh: {countdown}s </Text>
          <Text color="cyan">{countdownBar}</Text>
        </Box>
      )}
      <Text dimColor>
        {'  '}{snapshotCount} snapshots
        {lastScraped ? `  ·  Scraped ${formatTimeAgo(lastScraped)}` : ''}
      </Text>
    </Box>
  );
}

// Memoized chart — only re-renders when snapshots actually change
const MemoChart = memo(function MemoChart({ snapshots, currency }: { snapshots: Snapshot[]; currency: string }) {
  return <PriceChart snapshots={snapshots} currency={currency} />;
});

// Memoized price table
const PriceTable = memo(function PriceTable({ snapshots }: { snapshots: Snapshot[] }) {
  const latestByAirline = new Map<string, Snapshot>();
  for (const s of snapshots) {
    if (!latestByAirline.has(s.airline) || s.scrapedAt > latestByAirline.get(s.airline)!.scrapedAt) {
      latestByAirline.set(s.airline, s);
    }
  }
  const priceHistory = [...latestByAirline.values()].sort((a, b) => a.price - b.price);

  if (priceHistory.length === 0) return null;

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color="cyan">Current Prices</Text>
      <Box>
        <Text dimColor bold>{'Airline'.padEnd(16)}</Text>
        <Text dimColor bold>{'Price'.padEnd(10)}</Text>
        <Text dimColor bold>{'Stops'.padEnd(10)}</Text>
        <Text dimColor bold>{'Duration'.padEnd(10)}</Text>
        <Text dimColor bold>{'Seen'}</Text>
      </Box>
      {priceHistory.map((s) => (
        <Box key={s.id}>
          <Text>{s.airline.padEnd(16)}</Text>
          <Text color="green" bold>{formatCurrency(s.price, s.currency).padEnd(10)}</Text>
          <Text>{formatStops(s.stops).padEnd(10)}</Text>
          <Text dimColor>{(s.duration ?? '—').padEnd(10)}</Text>
          <Text dimColor>{formatTimeAgo(s.scrapedAt)}</Text>
        </Box>
      ))}
    </Box>
  );
});

interface QueryViewProps {
  id: string;
  onBack?: () => void;
}

export function QueryView({ id, onBack }: QueryViewProps) {
  const { exit } = useApp();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState<QueryData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const isTTY = process.stdin.isTTY ?? false;
  const prevSnapshotCount = useRef(0);
  const [newDataFlash, setNewDataFlash] = useState(false);

  const fetchData = useCallback(async (isInitial = false) => {
    try {
      if (!isInitial) setRefreshing(true);

      const row = await prisma.query.findUnique({
        where: { id },
        include: {
          snapshots: {
            where: { status: 'available' },
            orderBy: { scrapedAt: 'desc' },
          },
          fetchRuns: {
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { startedAt: true },
          },
        },
      });

      if (!row) {
        setError(`Query "${id}" not found`);
        return;
      }

      const snapshots = row.snapshots.map((s) => ({
        id: s.id,
        price: s.price,
        currency: s.currency,
        airline: s.airline,
        stops: s.stops,
        duration: s.duration,
        bookingUrl: s.bookingUrl,
        travelDate: s.travelDate,
        scrapedAt: s.scrapedAt,
        status: s.status,
      }));

      if (!isInitial && snapshots.length > prevSnapshotCount.current) {
        setNewDataFlash(true);
        setTimeout(() => setNewDataFlash(false), 2000);
      }
      prevSnapshotCount.current = snapshots.length;

      setQuery({
        id: row.id,
        origin: row.origin,
        originName: row.originName,
        destination: row.destination,
        destinationName: row.destinationName,
        dateFrom: row.dateFrom,
        dateTo: row.dateTo,
        currency: row.currency,
        active: row.active,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        snapshots,
        lastScraped: row.fetchRuns[0]?.startedAt ?? null,
      });
    } catch (err) {
      if (!query) setError(err instanceof Error ? err.message : 'Failed to load query');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, query]);

  useEffect(() => {
    fetchData(true);
  }, [id]);

  useInput((input, key) => {
    if (input === 'q') exit();
    if (input === 'r' && !refreshing) fetchData();
    if ((input === 'b' || key.escape) && onBack) onBack();
  }, { isActive: isTTY });

  if (loading) {
    return (
      <Box>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text>{' '}Loading query {id}...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">{'⚠ '}{error}</Text>;
  }

  if (!query) return null;

  const available = query.snapshots.filter((s) => s.status === 'available');

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="white">{query.originName}</Text>
        <Text dimColor>{` (${query.origin})`}</Text>
        <Text color="cyan">{' → '}</Text>
        <Text bold color="white">{query.destinationName}</Text>
        <Text dimColor>{` (${query.destination})`}</Text>
        <Text dimColor>{'  '}{formatDate(query.dateFrom)} – {formatDate(query.dateTo)}</Text>
        {newDataFlash && <Text color="green" bold>{'  ● NEW DATA'}</Text>}
      </Box>

      <MemoChart snapshots={available} currency={query.currency ?? 'USD'} />

      <Box marginTop={1}>
        <BestPriceCard snapshots={available} />
      </Box>

      <PriceTable snapshots={available} />

      <Box marginTop={1}>
        <CountdownBar
          refreshing={refreshing}
          onRefresh={fetchData}
          snapshotCount={available.length}
          lastScraped={query.lastScraped}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{onBack ? 'b: back  ' : ''}r: refresh now  q: quit</Text>
      </Box>
    </Box>
  );
}
