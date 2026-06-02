/**
 * End-to-end test: Frankfurt → Bogota, December 2026
 * Runs the full CLI pipeline without TUI: parse → preview → create → display chart
 *
 * Usage: doppler run -- node --import tsx/esm --import ./packages/cli/register.mjs packages/cli/src/e2e-test.ts
 */
import { parseFlightQuery } from '../../../apps/web/src/lib/scraper/parse-query.js';
import { previewFlights, type RouteResult } from './lib/preview.js';
import { createTrackedQueries } from './lib/create-queries.js';
import { renderBrailleChart, type ChartSeries } from './lib/chart.js';
import { formatCurrency } from './lib/format.js';

const RAW_INPUT = 'Frankfurt to Bogota December 2026 economy';

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  ✈  FLIGHT FINDER E2E TEST');
  console.log('  Frankfurt → Bogota, December 2026');
  console.log('═══════════════════════════════════════\n');

  // Step 1: Parse
  console.log('▸ Step 1: Parsing query with LLM...');
  const { response, usage: parseUsage } = await parseFlightQuery(RAW_INPUT);

  if (!response.parsed) {
    console.error('✗ Parse failed. Confidence:', response.confidence);
    console.error('  Ambiguities:', response.ambiguities.map((a) => a.question));
    process.exit(1);
  }

  const parsed = response.parsed;
  console.log(`  ✓ Parsed: ${parsed.origins.map((a) => a.code).join('/')} → ${parsed.destinations.map((a) => a.code).join('/')}`);
  console.log(`  Dates: ${parsed.dateFrom} to ${parsed.dateTo}`);
  console.log(`  Confidence: ${response.confidence}`);
  console.log(`  Parse tokens: ${parseUsage.inputTokens} in / ${parseUsage.outputTokens} out\n`);

  // Step 2: Preview (scrape Google Flights)
  console.log('▸ Step 2: Searching Google Flights via Playwright...');
  const routes: RouteResult[] = await previewFlights({
    parsed,
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  const withFlights = routes.filter((r) => r.flights.length > 0);
  const totalFlights = withFlights.reduce((sum, r) => sum + r.flights.length, 0);

  if (withFlights.length === 0) {
    console.error('✗ No flights found.');
    routes.filter((r) => r.error).forEach((r) => console.error(`  ${r.origin}→${r.destination}: ${r.error}`));
    process.exit(1);
  }

  console.log(`  ✓ Found ${totalFlights} flights across ${withFlights.length} route(s)\n`);

  // Print flights table
  for (const route of withFlights) {
    console.log(`  ${route.originName} → ${route.destinationName} (${route.date ?? 'range'})`);
    console.log('  ' + 'Airline'.padEnd(16) + 'Price'.padEnd(10) + 'Stops'.padEnd(10) + 'Duration');
    console.log('  ' + '─'.repeat(50));
    for (const f of route.flights.slice(0, 10)) {
      const stops = f.stops === 0 ? 'Nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
      console.log(`  ${f.airline.padEnd(16)}${formatCurrency(f.price, parsed.currency ?? 'USD').padEnd(10)}${stops.padEnd(10)}${f.duration ?? '—'}`);
    }
    console.log('');
  }

  // Step 3: Create tracked query
  console.log('▸ Step 3: Creating tracked query in DB...');
  const selections = withFlights.map((route) => ({
    route,
    flights: route.flights.slice(0, 10),
  }));

  const queries = await createTrackedQueries(parsed, RAW_INPUT, selections);
  console.log(`  ✓ Created ${queries.length} tracker(s):`);
  for (const q of queries) {
    console.log(`    ${q.origin} → ${q.destination}  ID: ${q.id}`);
  }
  console.log('');

  // Step 4: Render chart
  console.log('▸ Step 4: Rendering price chart...\n');
  const allFlights = withFlights.flatMap((r) => r.flights);
  const byAirline = new Map<string, Array<{ x: number; y: number }>>();
  for (const f of allFlights) {
    const t = new Date(f.travelDate).getTime();
    if (!byAirline.has(f.airline)) byAirline.set(f.airline, []);
    byAirline.get(f.airline)!.push({ x: t, y: f.price });
  }

  const series: ChartSeries[] = [];
  for (const [airline, points] of byAirline) {
    series.push({ label: airline, points });
  }

  const chart = renderBrailleChart(series, {
    width: Math.min(process.stdout.columns || 80, 100),
    height: 14,
    yLabel: formatCurrency(0, parsed.currency ?? 'USD').charAt(0),
    xLabels: [...new Set(allFlights.map((f) => f.travelDate))].sort().slice(0, 5),
  });

  console.log(chart);
  console.log('\n═══════════════════════════════════════');
  console.log('  ✓ E2E test complete');
  console.log(`  View with: flightfinder --view ${queries[0]?.id}`);
  console.log('═══════════════════════════════════════');

  // Clean exit (close Prisma/Redis connections)
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ E2E test failed:', err);
  process.exit(1);
});
