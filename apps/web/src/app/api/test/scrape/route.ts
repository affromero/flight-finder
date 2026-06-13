import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { extractPrices } from '@/lib/scraper/extract-prices';
import { readFileSync } from 'fs';
import { join } from 'path';

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

async function runCheck(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, passed: true, detail, durationMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, passed: false, detail: msg, durationMs: Date.now() - start };
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError('Unauthorized', 401);
  }

  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${cronSecret}`;

  const authorized =
    !!authHeader &&
    authHeader.length === expected.length &&
    timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));

  if (!authorized) {
    return apiError('Unauthorized', 401);
  }

  const checks: CheckResult[] = [];

  // --- Check 1: Database connectivity ---
  checks.push(
    await runCheck('database', async () => {
      await prisma.$queryRaw`SELECT 1`;
      return 'Connected';
    })
  );

  // --- Check 2: Chromium binary exists ---
  checks.push(
    await runCheck('chromium', async () => {
      const { execSync } = await import('child_process');
      const chromePath = process.env.CHROME_PATH || 'chromium-browser';
      const version = execSync(`${chromePath} --version`, { timeout: 5000 }).toString().trim();
      return version;
    })
  );

  // --- Check 2b: Playwright can actually launch a browser ---
  // The version check above only proves the binary exists. This drives the real
  // scraper launch path (launchBrowser -> import('playwright') -> chromium.launch),
  // which loads playwright-core/browsers.json and the system chromium. It is the
  // guard that would have caught the standalone build dropping browsers.json,
  // which the version check and the fixture-based extraction check both miss.
  checks.push(
    await runCheck('browser_launch', async () => {
      const { launchBrowser } = await import('@/lib/scraper/browser');
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.setContent('<h1>flight-finder smoke</h1>');
        const text = await page.textContent('h1');
        if (text !== 'flight-finder smoke') {
          throw new Error(`unexpected rendered text: ${text}`);
        }
        return `Launched ${browser.version()} and rendered a page`;
      } finally {
        await browser.close();
      }
    })
  );

  // --- Check 3: Extraction pipeline with fixture ---
  let testQueryId: string | null = null;

  checks.push(
    await runCheck('extraction', async () => {
      // Load fixture HTML - try filesystem paths first, fall back to inline
      let fixtureHtml = INLINE_FIXTURE;
      const paths = [
        join(process.cwd(), 'apps/web/src/test/fixtures/google-flights-sample.txt'),
        join(process.cwd(), 'src/test/fixtures/google-flights-sample.txt'),
        join(process.cwd(), 'test/fixtures/google-flights-sample.txt'),
      ];
      for (const p of paths) {
        try {
          fixtureHtml = readFileSync(p, 'utf-8');
          break;
        } catch {
          // Try next path
        }
      }

      // Ensure ExtractionConfig exists (LLMock uses anthropic provider)
      await prisma.extractionConfig.upsert({
        where: { id: 'singleton' },
        update: {},
        create: { id: 'singleton', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      });

      const result = await extractPrices(
        fixtureHtml,
        'https://www.google.com/travel/flights?q=flights+from+JFK+to+LAX',
        '2026-06-15',
        { maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any', cabinClass: 'economy' },
        10,
        true,
        'google_flights',
        'USD'
      );

      if (result.failureReason) {
        throw new Error(`Extraction failed: ${result.failureReason}`);
      }

      if (result.prices.length === 0) {
        throw new Error('Extraction returned 0 prices');
      }

      return `Extracted ${result.prices.length} prices (cheapest: $${result.prices[0]?.price})`;
    })
  );

  // --- Check 4: DB write + read round-trip ---
  checks.push(
    await runCheck('db_write_read', async () => {
      // Create a test query
      const query = await prisma.query.create({
        data: {
          rawInput: '__smoke_test__',
          origin: 'JFK',
          originName: 'New York JFK',
          destination: 'LAX',
          destinationName: 'Los Angeles',
          dateFrom: new Date('2026-06-15'),
          dateTo: new Date('2026-06-22'),
          expiresAt: new Date(Date.now() + 60_000), // 1 min
          active: false, // Don't let real scraper pick this up
        },
      });
      testQueryId = query.id;

      // Write a test snapshot
      await prisma.priceSnapshot.create({
        data: {
          queryId: query.id,
          travelDate: new Date('2026-06-15'),
          price: 189,
          currency: 'USD',
          airline: 'Delta',
          bookingUrl: 'https://example.com',
          stops: 0,
          duration: '6h 15m',
        },
      });

      // Read it back
      const snapshots = await prisma.priceSnapshot.findMany({
        where: { queryId: query.id },
      });

      if (snapshots.length !== 1) {
        throw new Error(`Expected 1 snapshot, got ${snapshots.length}`);
      }

      if (snapshots[0]!.price !== 189) {
        throw new Error(`Expected price 189, got ${snapshots[0]!.price}`);
      }

      return `Write + read OK (query=${query.id}, snapshot=${snapshots[0]!.id})`;
    })
  );

  // --- Cleanup: delete test query (cascades to snapshots) ---
  if (testQueryId) {
    try {
      await prisma.query.delete({ where: { id: testQueryId } });
    } catch {
      // Best-effort cleanup
    }
  }

  const allPassed = checks.every((c) => c.passed);
  const totalMs = checks.reduce((sum, c) => sum + c.durationMs, 0);

  const summary = {
    ok: allPassed,
    totalMs,
    checks,
  };

  // Always return the full check details, even on failure
  if (!allPassed) {
    return NextResponse.json({ ok: false, error: `Smoke test failed: ${checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}`, data: summary }, { status: 500 });
  }

  return apiSuccess(summary);
}

// Inline fixture for Docker environments where the fixture file isn't on disk
const INLINE_FIXTURE = `Google Flights

Flights from New York to Los Angeles

Showing results for Jun 15 - Jun 22

Best departing flights
Sorted by price

Delta
6:00 AM - 9:15 AM
JFK - LAX
Nonstop · 6h 15m
$189
Jun 15

JetBlue
8:30 AM - 11:55 AM
JFK - LAX
Nonstop · 6h 25m
$215
Jun 15

United
10:00 AM - 2:30 PM
EWR - LAX
1 stop · 8h 30m
ORD
$172
3 seats left at this price
Jun 15

American Airlines
12:45 PM - 4:00 PM
JFK - LAX
Nonstop · 6h 15m
$245
Jun 15

Spirit
7:00 PM - 10:45 PM
LGA - LAX
1 stop · 9h 45m
FLL
$98
2 seats left at this price
Jun 15

Alaska Airlines
3:15 PM - 6:30 PM
JFK - LAX
Nonstop · 6h 15m
$205
Jun 15

Prices include required taxes + fees for 1 adult. Optional charges and bag fees may apply.
Displayed currencies may differ from the currencies used to purchase flights.`;
