import { prisma } from '@/lib/prisma';
import { refreshCarTracker } from '../cars/store';
import { cleanupHotelSearches, reconcileHotelJobs, scheduleDueHotels } from '../hotels/runner';
import { deliverHotelAlerts } from '../hotels/alerts';
import { deliverCarAlerts } from '../cars/delivery';
import { deliverFlightAlerts } from '../notifications/flights';
import { notificationTransaction } from '../notifications/database';
import { pumpTravelJobs } from './coordinator';
import { expireQueuedPreviews } from './preview';

type AlertKind = 'car' | 'hotel' | 'flight';
const runtime = globalThis as typeof globalThis & {
  travelTimer?: ReturnType<typeof setTimeout>; travelPump?: Promise<void>;
  travelAlertTimers?: Partial<Record<AlertKind, ReturnType<typeof setTimeout>>>;
  travelAlertPumps?: Partial<Record<AlertKind, Promise<void>>>;
};

async function scheduleDueCars(): Promise<void> {
  const due = await prisma.carTracker.findMany({ where: { active: true, nextCheckAt: { lte: new Date() } }, orderBy: { nextCheckAt: 'asc' }, take: 20 });
  for (const tracker of due) {
    try { await refreshCarTracker(tracker.id, { userId: tracker.userId, isAdmin: true }, true); }
    catch (error) {
      console.error('[cars] Scheduled check could not be queued:', error);
      await prisma.carTracker.updateMany({ where: { id: tracker.id, revision: tracker.revision }, data: { lastError: 'Scheduled check could not start; review rental dates and settings.', nextCheckAt: new Date(Date.now() + 3_600_000) } });
    }
  }
}

async function pump(): Promise<void> {
  await expireQueuedPreviews();
  const config = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { enabled: true } });
  if (config?.enabled === false) return;
  if (process.env.SELF_HOSTED === 'true') {
    await reconcileHotelJobs();
    await cleanupHotelSearches();
    await scheduleDueHotels();
    await scheduleDueCars();
  }
  await pumpTravelJobs();
}
async function runAlerts(kind: AlertKind): Promise<void> {
  const pumps = runtime.travelAlertPumps ??= {};
  if (pumps[kind]) return pumps[kind];
  pumps[kind] = (async () => {
    if (kind !== 'flight' && process.env.SELF_HOSTED !== 'true') return;
    const config = await notificationTransaction(tx => tx.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { enabled: true } }));
    if (config?.enabled === false) return;
    await (kind === 'car' ? deliverCarAlerts() : kind === 'hotel' ? deliverHotelAlerts() : deliverFlightAlerts());
  })().catch(error => { console.error(`[travel] ${kind} notification worker failed:`, error); }).finally(() => { delete pumps[kind]; });
  return pumps[kind];
}
export async function runTravelAlertsSafely(): Promise<void> {
  await Promise.all([runAlerts('car'), runAlerts('hotel'), runAlerts('flight')]);
}
export async function runTravelJobsSafely(): Promise<void> {
  if (!runtime.travelPump) runtime.travelPump = pump().catch(error => { console.error('[travel] Scheduled worker failed:', error); }).finally(() => { runtime.travelPump = undefined; });
  return runtime.travelPump;
}
export async function runTravelBackgroundWork(): Promise<void> {
  await Promise.all([runTravelJobsSafely(), runTravelAlertsSafely()]);
}
export function startTravelScheduler(): void {
  if (process.env.CRON_ENABLED === 'false' || runtime.travelTimer) return;
  const tick = async () => {
    await runTravelJobsSafely();
    runtime.travelTimer = setTimeout(() => { void tick(); }, 60_000);
    runtime.travelTimer.unref();
  };
  runtime.travelTimer = setTimeout(() => { void tick(); }, 1000);
  runtime.travelTimer.unref();
  const timers = runtime.travelAlertTimers ??= {};
  for (const kind of ['car', 'hotel', 'flight'] as const) {
    if (timers[kind]) continue;
    const alertTick = async () => {
      await runAlerts(kind);
      timers[kind] = setTimeout(() => { void alertTick(); }, 60_000);
      timers[kind]?.unref();
    };
    timers[kind] = setTimeout(() => { void alertTick(); }, 1000);
    timers[kind]?.unref();
  }
}
