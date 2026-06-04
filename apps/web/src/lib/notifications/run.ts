import { prisma } from '@/lib/prisma';
import { detectNewLow } from './detect';
import { formatNewLowMessage } from './format';
import { dispatchNotifications } from './notify';

/** Base URL for deep links in notifications. Self-hosters set APP_URL to their
 * own domain; Phase 4 also exposes this in the admin config. */
function resolveBaseUrl(): string {
  return (process.env.APP_URL || 'https://flight-finder.org').replace(/\/+$/, '');
}

/**
 * For every query scraped in the current cycle, check whether it hit a new low
 * and, if so, push a notification to the owner's channels and record the low so
 * we never alert twice for the same price.
 *
 * Each query is isolated: a failure for one is logged and skipped, never
 * thrown, so the caller (a cron run or a manual scrape) is never broken by
 * notification work. `cycleStartedAt` must be captured BEFORE the scrape so the
 * snapshots written during it count as "current".
 */
export async function notifyNewLows(queryIds: string[], cycleStartedAt: Date): Promise<void> {
  const ids = [...new Set(queryIds)];
  if (ids.length === 0) return;

  const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
  const floorAbs = config?.notifyMinDropAbs ?? 5;
  const floorPct = config?.notifyMinDropPct ?? 0;
  const baseUrl = resolveBaseUrl();

  for (const queryId of ids) {
    try {
      const query = await prisma.query.findUnique({
        where: { id: queryId },
        select: {
          id: true,
          origin: true,
          destination: true,
          currency: true,
          userId: true,
          lastNotifiedLowPrice: true,
        },
      });
      if (!query) continue;

      const alert = await detectNewLow({
        query: {
          id: query.id,
          currency: query.currency,
          lastNotifiedLowPrice: query.lastNotifiedLowPrice,
        },
        cycleStartedAt,
        floorAbs,
        floorPct,
      });
      if (!alert) continue;

      const message = formatNewLowMessage({
        alert,
        route: { origin: query.origin, destination: query.destination },
        baseUrl,
      });
      const outcomes = await dispatchNotifications(query.userId, message);

      // Only advance the dedupe marker once we actually had a channel to send
      // to. With no channels, leave it untouched so the user starts getting
      // alerts as soon as they configure one (no silently-consumed low).
      if (outcomes.length > 0) {
        await prisma.query.update({
          where: { id: query.id },
          data: { lastNotifiedLowPrice: alert.currentMin, lastNotifiedAt: new Date() },
        });
      }

      const sent = outcomes.filter((o) => o.ok).length;
      console.log(
        `[notify] query=${query.id} new low ${alert.currentMin} (was ${alert.baseline}) ` +
          `channels=${outcomes.length} sent=${sent} failed=${outcomes.length - sent}`,
      );
      for (const o of outcomes.filter((o) => !o.ok)) {
        console.error(`[notify] query=${query.id} channel=${o.channelId} type=${o.type} failed: ${o.error}`);
      }
    } catch (err) {
      console.error(
        `[notify] query=${queryId} notification failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
