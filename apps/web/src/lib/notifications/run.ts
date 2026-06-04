import { prisma } from '@/lib/prisma';
import { detectNewLow } from './detect';
import { formatNewLowMessage } from './format';
import { dispatchNotifications } from './notify';

/**
 * Base URL for deep links in notifications. Precedence: admin-configured
 * publicBaseUrl, then APP_URL env. Returns null when nothing is configured on a
 * self-hosted instance, so alerts omit the link rather than pointing at the
 * hosted flight-finder.org (where the local /q/<id> would not exist). Only the
 * hosted instance itself (SELF_HOSTED unset) falls back to flight-finder.org.
 */
export function resolveBaseUrl(publicBaseUrl?: string | null): string | null {
  const configured = publicBaseUrl || process.env.APP_URL;
  if (configured) return configured.replace(/\/+$/, '');
  if (process.env.SELF_HOSTED === 'true') return null;
  return 'https://flight-finder.org';
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
  const baseUrl = resolveBaseUrl(config?.publicBaseUrl);

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

      // Only advance the dedupe marker once at least one channel actually
      // delivered. A transient failure on every channel must not consume the
      // low and suppress the retry next cycle; and with no channels at all we
      // leave it untouched so alerts start the moment one is configured.
      if (outcomes.some((o) => o.ok)) {
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
