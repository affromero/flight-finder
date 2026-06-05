import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { apiSuccess, apiError } from '@/lib/api-response';
import { runScrapeAll, cleanupUnvisitedQueries } from '@/lib/scraper/run-scrape';
import { expireDepartedQueries } from '@/lib/scraper/expire-queries';
import { notifyNewLows } from '@/lib/notifications/run';

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

  // Clean up queries never visited within 24h
  const deletedUnvisited = await cleanupUnvisitedQueries();

  // Deactivate trackers whose departure day has already passed
  const expiredDeparted = await expireDepartedQueries();

  // Capture the boundary BEFORE scraping so this cycle's snapshots count as
  // "current" for new-low detection.
  const cycleStartedAt = new Date();

  let results;
  try {
    results = await runScrapeAll();
  } catch (err) {
    if (err instanceof Error && err.message === 'Scrape already in progress') {
      return apiError('Scrape already in progress', 409);
    }
    throw err;
  }

  // Fire new-low alerts for queries that produced fresh prices this cycle.
  // Isolated so notification failures never fail the cron run.
  try {
    const successfulQueryIds = results.filter((r) => r.status === 'success').map((r) => r.queryId);
    await notifyNewLows(successfulQueryIds, cycleStartedAt);
  } catch (err) {
    console.error(`[notify] cron notification pass failed: ${err instanceof Error ? err.message : err}`);
  }

  const summary = {
    deletedUnvisited,
    expiredDeparted,
    queriesProcessed: results.length,
    successful: results.filter((r) => r.status === 'success').length,
    partial: results.filter((r) => r.status === 'partial').length,
    failed: results.filter((r) => r.status === 'failed').length,
    totalSnapshots: results.reduce((sum, r) => sum + r.snapshotsCount, 0),
    totalCost: results.reduce((sum, r) => sum + r.extractionCost, 0),
    results,
  };

  return apiSuccess(summary);
}
