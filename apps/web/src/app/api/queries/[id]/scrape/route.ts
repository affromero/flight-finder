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

  // Atomic check-and-reserve. Two concurrent POSTs (different tabs, admin +
  // account view on the same group) could both read "no in_progress rows"
  // before either inserted, then both pre-create + fire. A Serializable
  // transaction makes one of them retry (the loser sees Prisma's P2034 or
  // a Postgres 40001) so only one scrape kicks off. Also catches the case
  // where Redis is disabled entirely.
  //
  // Only the row for the originally-clicked id (`id`, not every sibling) is
  // pre-created. Sibling rows are created inside `runScrapeForQuery` when
  // the loop reaches them, so an early-exit (paused mid-cascade, process
  // crash, etc.) cannot leave orphaned in_progress rows behind to block
  // future refreshes.
  let primaryFetchRun: { id: string };
  try {
    primaryFetchRun = await prisma.$transaction(async (tx) => {
      const inProgress = await tx.fetchRun.findFirst({
        where: { queryId: { in: targetIds }, status: 'in_progress' },
        select: { id: true },
      });
      if (inProgress) {
        throw new Error('SCRAPE_IN_PROGRESS');
      }
      return tx.fetchRun.create({
        data: { queryId: id, status: 'in_progress', source: 'manual' },
        select: { id: true },
      });
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    if (err instanceof Error && err.message === 'SCRAPE_IN_PROGRESS') {
      return apiError('A scrape is already running for this tracker. Wait for it to finish.', 429);
    }
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2034') {
      // Postgres serialization conflict — another request beat us to it.
      return apiError('A scrape is already running for this tracker. Wait for it to finish.', 429);
    }
    throw err;
  }

  // Reorder so the user-clicked row scrapes first (and reuses the pre-
  // created row). Subsequent siblings get their FetchRun rows created
  // just-in-time inside runScrapeForQuery; any sibling we never reach
  // simply has no row, instead of an orphan stuck at in_progress.
  const orderedTargets = [id, ...targetIds.filter((qid) => qid !== id)];
  void (async () => {
    for (let i = 0; i < orderedTargets.length; i++) {
      const qid = orderedTargets[i]!;
      const passOpts = i === 0 ? { fetchRunId: primaryFetchRun.id } : undefined;
      try {
        await runFullScrapeForQuery(qid, passOpts);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[scrape] manual run failed query=${qid}: ${errorMsg}`);
        // If runFullScrapeForQuery throws before runScrapeForQuery has a
        // chance to finalise the pre-created primary row, that row stays
        // at in_progress forever and the DB lock blocks every future
        // refresh for this group. Best-effort failure update closes the
        // loop on the i=0 case (cron/sibling rows are created inside
        // runFullScrapeForQuery's loop so they finalise themselves).
        if (i === 0) {
          await prisma.fetchRun.update({
            where: { id: primaryFetchRun.id },
            data: { status: 'failed', error: errorMsg, completedAt: new Date() },
          }).catch(() => {});
        }
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
