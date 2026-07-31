/**
 * Live extraction regression guard (issue #139: "All searches end in
 * 'Flights exist but none matched your filters'").
 *
 * Every other extract test mocks the `extract()` function or stubs the SDK at
 * the HTTP layer (LLMock), so they validate the filter logic but never the real
 * model -> regex -> JSON.parse -> validity-filter path. A regression in the
 * prompt, the JSON-extraction regex, or the LLM output shape that empties
 * `validPrices` would surface as `all_filtered_out` in production yet stay green
 * in the suite. This test runs the genuine `claude-code` CLI provider (no API
 * key, just the host's Claude auth) against the bundled Google Flights fixture
 * and asserts real, schema-valid flights come out the other side.
 *
 * Gated: runs only when RUN_LLM_INTEGRATION=1 AND an authenticated `claude` CLI
 * is on PATH. Skips cleanly in CI / on boxes without Claude auth so the default
 * suite stays hermetic and fast.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractPrices, type QueryFilters } from './extract-prices';

function claudeIsUsable(): boolean {
  if (process.env.RUN_LLM_INTEGRATION !== '1') return false;
  try {
    execSync('which claude', { stdio: 'ignore' });
  } catch {
    return false;
  }
  const home = homedir();
  return (
    existsSync(join(home, '.claude.json')) ||
    existsSync(join(home, '.claude', 'credentials.json')) ||
    existsSync(join(home, '.claude', '.credentials.json'))
  );
}

const fixture = readFileSync(
  join(__dirname, '../../test/fixtures/google-flights-sample.txt'),
  'utf-8',
);

// A real ALB->CMH capture (issue #190). Google's compact result list writes the
// connection as a bare duration plus airport under the stop count ("55 min
// DTW") — no "layover" wording at all — and the one 2-stop itinerary has no
// connection line whatsoever. Both shapes are what the prompt has to survive.
const layoverFixture = readFileSync(
  join(__dirname, '../../test/fixtures/google-flights-layovers.txt'),
  'utf-8',
);

const CONFIG = {
  provider: 'claude-code',
  model: process.env.LLM_INTEGRATION_MODEL ?? 'sonnet',
  customBaseUrl: null,
} as const;

const SEARCH_URL = 'https://www.google.com/travel/flights?q=JFK+to+LAX+2026-06-15';
const FALLBACK_DATE = '2026-06-15';

const noFilters: QueryFilters = {
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  preferredAirlines: [],
  timePreference: 'any',
  cabinClass: 'economy',
};

describe.skipIf(!claudeIsUsable())('extractPrices live (claude-code) — issue #139 regression guard', () => {
  // The global test setup (src/test/setup.ts) points ANTHROPIC_BASE_URL at the
  // LLMock server to trap leaked SDK calls. The claude-code provider spawns the
  // real `claude` CLI, which would inherit that redirect and fail. Production
  // does not set these, so clear them for the spawn and restore afterwards.
  const PROXY_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL'];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of PROXY_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of PROXY_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns schema-valid flights from the real model, never all_filtered_out', async () => {
    const result = await extractPrices(
      fixture,
      SEARCH_URL,
      FALLBACK_DATE,
      noFilters,
      10,
      true,
      'google_flights',
      'USD',
      CONFIG,
    );

    expect(result.failureReason).toBeUndefined();
    // The fixture lists six flights; a healthy extraction recovers most of them.
    expect(result.prices.length).toBeGreaterThanOrEqual(4);

    // The exact gate that produces all_filtered_out: every row must have a
    // positive numeric price and a non-empty airline. A model returning the
    // wrong field names or stringified prices ("$189") would empty this.
    for (const p of result.prices) {
      expect(typeof p.price).toBe('number');
      expect(p.price).toBeGreaterThan(0);
      expect(p.airline.length).toBeGreaterThan(0);
    }

    const cheapest = Math.min(...result.prices.map((p) => p.price));
    expect(cheapest).toBe(98); // Spirit, the cheapest row in the fixture
  }, 120_000);

  it('honours a server-side duration filter without emptying valid results', async () => {
    const result = await extractPrices(
      fixture,
      SEARCH_URL,
      FALLBACK_DATE,
      { ...noFilters, maxDurationHours: 7 },
      10,
      true,
      'google_flights',
      'USD',
      CONFIG,
    );

    expect(result.failureReason).toBeUndefined();
    expect(result.prices.length).toBeGreaterThan(0);
    // 7h cap keeps the ~6h15m nonstops, drops the 8h30m / 9h45m one-stops.
    for (const p of result.prices) {
      expect(p.stops).toBe(0);
    }
  }, 120_000);

  it('reads layovers off a real connecting-route page, and invents none (issue #190)', async () => {
    const result = await extractPrices(
      layoverFixture,
      'https://www.google.com/travel/flights?q=flights+from+ALB+to+CMH',
      '2026-09-14',
      noFilters,
      10,
      true,
      'google_flights',
      'USD',
      CONFIG,
    );

    expect(result.failureReason).toBeUndefined();
    const oneStop = result.prices.filter((p) => p.stops === 1);
    expect(oneStop.length).toBeGreaterThanOrEqual(4);

    // Every one-stop row on this page has a connection line, and each layover
    // must match one that is actually printed — not one derived from the total
    // duration or the departure/arrival times.
    const onPage = new Set(['55m DTW', '59m ORD', '2h 5m BNA', '1h 17m PHL', '1h 43m ATL', '1h 30m ORD', '1h 15m ORD', '1h 8m PHL', '2h 50m ORD', '1h 50m BWI', '1h 14m IAD']);
    for (const p of oneStop) {
      expect(p.layovers).toHaveLength(1);
      const [leg] = p.layovers!;
      expect(onPage).toContain(`${leg!.duration} ${leg!.airport}`);
    }

    // The 11h 35m two-stop itinerary prints no connection line at all, so the
    // model must leave it empty rather than guess at one.
    for (const p of result.prices.filter((x) => x.stops === 2)) {
      expect(p.layovers ?? []).toHaveLength(0);
    }
  }, 120_000);
});
