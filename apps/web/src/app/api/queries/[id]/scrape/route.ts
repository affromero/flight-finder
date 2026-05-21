import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { authorizeMutation } from '@/lib/query-auth';
import { redis } from '@/lib/redis';
import { runFullScrapeForQuery } from '@/lib/scraper/run-scrape';

const THROTTLE_SECONDS = 60;

/**
 * Manual force-scrape endpoint. Fires `runFullScrapeForQuery` for the row
 * and (when present) every sibling sharing the `groupId`, the same way
 * pause/delete cascade. Returns 200 the instant the FetchRun rows are
 * pre-created so the UI dot can light up before the network IO begins;
 * the actual scrapes run sequentially in a background IIFE so multiple
 * siblings never race on the shared VPN sidecar.
 *
 * Two layered locks prevent overlapping kickoffs:
 *   - Redis SET NX EX (60s) catches accidental double-clicks at zero DB
 *     cost. Skipped gracefully when Redis is null or throws.
 *   - "Any in_progress FetchRun for any target" is a precise lock that
 *     outlasts the Redis TTL on multi-VPN runs (a single VPN connect can
 *     already take 30+ seconds). Always checked, even with Redis off.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const token = body?.deleteToken;

  const query = await prisma.query.findUnique({
    where: { id },
    select: {
      deleteToken: true,
      groupId: true,
      userId: true,
      active: true,
      isSeed: true,
      expiresAt: true,
    },
  });

  if (!query) return apiError('Tracker not found', 404);

  const auth = await authorizeMutation(query, token);
  if (!auth.ok) return apiError(auth.error ?? 'Forbidden', auth.status ?? 403);

  if (!query.active || query.isSeed) {
    return apiError('Tracker is paused or a seed; resume it before refreshing.', 409);
  }

  if (query.expiresAt.getTime() <= Date.now()) {
    return apiError('Tracker has expired; create a fresh one to keep scraping.', 410);
  }

  // Only target siblings that are themselves still alive (active, non-seed,
  // not expired). The primary already passed those checks above.
  const now = new Date();
  const targetIds = query.groupId
    ? (await prisma.query.findMany({
        where: {
          groupId: query.groupId,
          active: true,
          isSeed: false,
          expiresAt: { gt: now },
        },
        select: { id: true },
      })).map((q) => q.id)
    : [id];

  if (targetIds.length === 0) {
    return apiError('No active siblings to refresh', 409);
  }

  const throttleKey = `scrape:throttle:${query.groupId ?? id}`;
  let throttled = false;
  if (redis) {
    try {
      const reserved = await redis.set(throttleKey, '1', 'EX', THROTTLE_SECONDS, 'NX');
      throttled = reserved !== 'OK';
    } catch (err) {
      console.warn(`[scrape] redis throttle failed: ${err instanceof Error ? err.message : err}; allowing request`);
    }
  }
  if (throttled) {
    return apiError('Force scrape was triggered less than a minute ago. Try again shortly.', 429);
  }

  // Second lock that outlasts the Redis TTL. Multi-sibling or multi-VPN
  // runs can take many minutes; the Redis key expires long before then. A
  // direct DB check on `in_progress` rows catches that case AND also works
  // when Redis is disabled entirely.
  const stale = await prisma.fetchRun.findFirst({
    where: { queryId: { in: targetIds }, status: 'in_progress' },
    select: { id: true },
  });
  if (stale) {
    return apiError('A scrape is already running for this tracker. Wait for it to finish.', 429);
  }

  // Pre-create one FetchRun row per target so the next /api/queries/active
  // call sees status=in_progress immediately, well before VPN connect.
  const fetchRuns = await Promise.all(
    targetIds.map((qid) =>
      prisma.fetchRun.create({
        data: { queryId: qid, status: 'in_progress', source: 'manual' },
        select: { id: true, queryId: true },
      }),
    ),
  );

  // Fire scrapes serially in the background so siblings don't race the VPN
  // sidecar. Errors are swallowed per sibling (the FetchRun row's own
  // failed status surfaces them in the UI).
  const fetchRunByQuery = new Map(fetchRuns.map((fr) => [fr.queryId, fr.id]));
  void (async () => {
    for (const qid of targetIds) {
      const fetchRunId = fetchRunByQuery.get(qid);
      try {
        await runFullScrapeForQuery(qid, fetchRunId ? { fetchRunId } : undefined);
      } catch (err) {
        console.error(
          `[scrape] manual run failed query=${qid}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  })();

  return apiSuccess({
    accepted: true,
    count: targetIds.length,
    groupId: query.groupId,
    throttledUntil: redis ? new Date(Date.now() + THROTTLE_SECONDS * 1000).toISOString() : null,
  });
}
