import React from 'react';
import { Box, Text } from 'ink';
import { formatCurrency, formatStops } from '../lib/format.js';
import { pickBest, formatBookingLine, type BestPriceSnapshot } from '../lib/best-price.js';

interface BestPriceCardProps {
  snapshots: BestPriceSnapshot[];
}

export function BestPriceCard({ snapshots }: BestPriceCardProps) {
  const best = pickBest(snapshots);
  if (!best) return null;

  const bookingLine = formatBookingLine(best.bookingUrl);

  // The box hugs its content (alignSelf flex-start) and only ever holds short
  // lines, so ink keeps the border aligned. The booking url renders below the
  // box as its own line: a long url wraps naturally instead of blowing out the
  // border, and stays copyable in full.
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        alignSelf="flex-start"
      >
        <Text bold color="cyan">Best Price</Text>
        <Text>
          <Text color="green" bold>{formatCurrency(best.price, best.currency)}</Text>
          {'  '}
          <Text color="white">{best.airline}</Text>
          {' · '}
          <Text dimColor>{formatStops(best.stops)}</Text>
          {best.duration ? <Text dimColor>{` · ${best.duration}`}</Text> : null}
        </Text>
      </Box>
      {bookingLine && <Text dimColor>{bookingLine}</Text>}
    </Box>
  );
}
