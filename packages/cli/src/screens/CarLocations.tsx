import React, { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { CarTrackerView } from '../../../../apps/web/src/lib/cars/tracker-view.js';
import { carProviderLocationLabels } from '../../../../apps/web/src/lib/cars/location-labels.js';
import { CAR_PROVIDER_LABELS } from '../../../../apps/web/src/lib/cars/preferences.js';
import { carDocumentLines } from '../lib/car-document.js';

export function CarLocations({ tracker }: { tracker: CarTrackerView }) {
  const size = useWindowSize();
  const [offset, setOffset] = useState(0);
  const sources = tracker.selection ? [tracker.selection.source] : tracker.search.sources;
  const document = [tracker.label, ...(['pickup', 'dropoff'] as const).flatMap(stop => {
    const location = tracker.search[stop], time = tracker.search[stop === 'pickup' ? 'pickupAt' : 'dropoffAt'];
    const labels = carProviderLocationLabels(location, sources);
    return [stop === 'pickup' ? 'PICKUP' : 'RETURN', location.name, `${time.date} ${time.time} (${time.timeZone})`,
      ...(labels.length ? labels.map(({ source, name }) => `${CAR_PROVIDER_LABELS[source]} search location: ${name}`) : ['Provider search location not resolved.'])];
  }), 'Provider search locations are search areas, not supplier branch addresses. Review the rental conditions for collection instructions.'];
  const lines = carDocumentLines(document, Math.max(10, size.columns - 2)), count = Math.max(1, size.rows - 3);
  const start = Math.min(offset, Math.max(0, lines.length - count));
  useInput((input, key) => {
    if (key.upArrow) setOffset(Math.max(0, start - 1));
    if (key.downArrow) setOffset(Math.min(start + 1, Math.max(0, lines.length - count)));
  });
  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="#80a8a5" wrap="truncate-end">RENTAL LOCATIONS</Text>
    <Text dimColor wrap="truncate-end">Lines {start + 1}-{Math.min(start + count, lines.length)}/{lines.length}</Text>
    {lines.slice(start, start + count).map((line, index) => <Text key={start + index}>{line}</Text>)}
    <Text dimColor wrap="truncate-end">↑↓ scroll · Esc back · q quit</Text>
  </Box>;
}
