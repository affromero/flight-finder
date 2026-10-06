import React from 'react';
import { Box, Text } from 'ink';
import type { ParsedFlightQuery } from '../../../../apps/web/src/lib/scraper/parse-query.js';

interface ParsedQueryCardProps {
  parsed: ParsedFlightQuery;
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function ParsedQueryCard({ parsed }: ParsedQueryCardProps) {
  const origins = parsed.origins.map((a) => a.code).join(', ');
  const originNames = parsed.origins.map((a) => a.name).join(', ');
  const dests = parsed.destinations.map((a) => a.code).join(', ');
  const destNames = parsed.destinations.map((a) => a.name).join(', ');

  const dateRange = `${formatDate(parsed.dateFrom)} — ${formatDate(parsed.dateTo)}`;
  const flex = parsed.flexibility > 0 ? ` ±${parsed.flexibility}d` : '';

  const filters: string[] = [];
  if (parsed.maxPrice) filters.push(`Under ${parsed.currency} ${parsed.maxPrice}`);
  if (parsed.maxStops === 0) filters.push('Nonstop');
  else if (parsed.maxStops === 1) filters.push('Max 1 stop');
  if (parsed.cabinClass !== 'economy') filters.push(parsed.cabinClass.replace('_', ' '));
  if (parsed.tripType === 'one_way') filters.push('One way');
  if (parsed.preferredAirlines.length > 0) filters.push(parsed.preferredAirlines.join(', '));
  if (parsed.timePreference !== 'any') filters.push(`${parsed.timePreference}${parsed.strictDepartureTime ? ' (strict, airport local time)' : ''}`);

  return (
    <Box flexDirection="column">
      <Text color="cyan">{'┌─ Route ─────────────────────────────┐'}</Text>
      <Text color="cyan">{'│'} <Text bold color="white">{origins}</Text> <Text dimColor>→</Text> <Text bold color="white">{dests}</Text><Text>{'                              '.slice(0, 35 - origins.length - dests.length - 4)}</Text><Text color="cyan">{'│'}</Text></Text>
      <Text color="cyan">{'│'} <Text dimColor>{originNames}</Text><Text>{'                                    '.slice(0, 35 - originNames.length)}</Text><Text color="cyan">{'│'}</Text></Text>
      <Text color="cyan">{'│'} <Text dimColor>→ {destNames}</Text><Text>{'                                    '.slice(0, 33 - destNames.length)}</Text><Text color="cyan">{'│'}</Text></Text>
      <Text color="cyan">{'├─ Dates ─────────────────────────────┤'}</Text>
      <Text color="cyan">{'│'} <Text color="white">{dateRange}{flex}</Text><Text>{'                                    '.slice(0, 35 - dateRange.length - flex.length)}</Text><Text color="cyan">{'│'}</Text></Text>
      {filters.length > 0 && (
        <>
          <Text color="cyan">{'├─ Filters ───────────────────────────┤'}</Text>
          <Text color="cyan">{'│'} <Text color="white">{filters.join(' · ')}</Text><Text>{'                                    '.slice(0, 35 - filters.join(' · ').length)}</Text><Text color="cyan">{'│'}</Text></Text>
        </>
      )}
      <Text color="cyan">{'└─────────────────────────────────────┘'}</Text>
    </Box>
  );
}
