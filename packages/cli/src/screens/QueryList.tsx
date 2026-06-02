import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { prisma } from '@/lib/prisma';
import { formatDate, formatCurrency, formatTimeAgo } from '../lib/format.js';

interface QueryRow {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  dateFrom: Date;
  dateTo: Date;
  active: boolean;
  expiresAt: Date | null;
  currency: string | null;
  lastScraped: Date | null;
  minPrice: number | null;
  maxPrice: number | null;
  snapshotCount: number;
}

interface QueryListProps {
  onView?: (id: string) => void;
}

export function QueryList({ onView }: QueryListProps) {
  const { exit } = useApp();
  const [loading, setLoading] = useState(true);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const rows = await prisma.query.findMany({
          orderBy: { createdAt: 'desc' },
          include: {
            snapshots: {
              orderBy: { price: 'asc' },
              select: { price: true },
            },
            fetchRuns: {
              orderBy: { startedAt: 'desc' },
              take: 1,
              select: { startedAt: true },
            },
          },
        });

        setQueries(
          rows.map((r) => ({
            id: r.id,
            origin: r.origin,
            originName: r.originName,
            destination: r.destination,
            destinationName: r.destinationName,
            dateFrom: r.dateFrom,
            dateTo: r.dateTo,
            active: r.active,
            expiresAt: r.expiresAt,
            currency: r.currency,
            lastScraped: r.fetchRuns[0]?.startedAt ?? null,
            minPrice: r.snapshots.length > 0 ? r.snapshots[0]!.price : null,
            maxPrice: r.snapshots.length > 0 ? r.snapshots[r.snapshots.length - 1]!.price : null,
            snapshotCount: r.snapshots.length,
          })),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load queries');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const isTTY = process.stdin.isTTY ?? false;

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(queries.length - 1, c + 1));
    else if (key.return && queries[cursor]) {
      if (onView) onView(queries[cursor]!.id);
    } else if (input === 'q') exit();
  }, { isActive: isTTY });

  if (loading) {
    return (
      <Box>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text>{' '}Loading queries...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">{'⚠ '}{error}</Text>;
  }

  if (queries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No tracked queries yet.</Text>
        <Text dimColor>Run <Text color="white">flightfinder</Text> to search and track flights.</Text>
      </Box>
    );
  }

  const now = new Date();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Tracked Queries</Text>
        <Text dimColor> ({queries.length})</Text>
      </Box>

      <Box>
        <Text dimColor bold>{'  '}</Text>
        <Text dimColor bold>{'Route'.padEnd(18)}</Text>
        <Text dimColor bold>{'Dates'.padEnd(20)}</Text>
        <Text dimColor bold>{'Status'.padEnd(10)}</Text>
        <Text dimColor bold>{'Last Scraped'.padEnd(14)}</Text>
        <Text dimColor bold>{'Prices'}</Text>
      </Box>

      {queries.map((q, i) => {
        const isCursor = i === cursor;
        const route = `${q.origin} → ${q.destination}`;
        const dates = `${formatDate(q.dateFrom)} – ${formatDate(q.dateTo)}`;
        // Departure passed means the trip is unbookable; show Expired even if
        // the scrape sweep has not yet flipped active to false.
        const departed = q.dateFrom < todayStart;
        const isExpired = departed || (q.expiresAt !== null && q.expiresAt < now);
        const status = isExpired ? 'Expired' : !q.active ? 'Paused' : 'Active';
        const statusColor = status === 'Active' ? 'green' : status === 'Expired' ? 'red' : 'yellow';
        const lastScraped = q.lastScraped ? formatTimeAgo(q.lastScraped) : '—';
        const prices = q.minPrice !== null && q.maxPrice !== null
          ? `${formatCurrency(q.minPrice, q.currency ?? 'USD')} – ${formatCurrency(q.maxPrice, q.currency ?? 'USD')}`
          : '—';

        return (
          <Box key={q.id}>
            <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '▸ ' : '  '}</Text>
            <Text color={isCursor ? 'white' : undefined} bold={isCursor}>
              {route.padEnd(18)}
            </Text>
            <Text>{dates.padEnd(20)}</Text>
            <Text color={statusColor}>{status.padEnd(10)}</Text>
            <Text dimColor>{lastScraped.padEnd(14)}</Text>
            <Text color="green">{prices}</Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>↑↓: navigate  enter: view chart  q: quit</Text>
      </Box>
    </Box>
  );
}
