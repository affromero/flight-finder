import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { validateHotelSearch, expandHotelStays, matchesHotelFilters, matchHotelSelection } from './domain';
import { searchHotelSource, PartialHotelSourceError } from './providers';
import { json, lockHotelTracker, refreshHotelTracker } from './store';
import { deliverHotelAlerts, recordHotelAlerts } from './alerts';
import type { HotelSearchRun, HotelTracker, Prisma } from '@/generated/prisma/client';
import type { HotelSearchResult, HotelSelection, HotelTrackingOptions } from './types';

const LEASE_MS = 120_000;
const ACTIVE = ['queued', 'running'];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function acquireLease(owner: string): Promise<boolean> {
  await prisma.hotelLease.upsert({ where: { id: 'worker' }, create: { id: 'worker', owner, expiresAt: new Date(0) }, update: {} });
  const claimed = await prisma.hotelLease.updateMany({ where: { id: 'worker', expiresAt: { lte: new Date() } }, data: { owner, expiresAt: new Date(Date.now() + LEASE_MS) } });
  return claimed.count === 1;
}
async function lockLease(tx: Prisma.TransactionClient, owner: string): Promise<boolean> {
  const lease = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "HotelLease" WHERE "id" = 'worker' AND "owner" = ${owner} AND "expiresAt" > ${new Date()} FOR UPDATE`;
  return lease.length > 0;
}
async function scheduleDue() {
  const due = await prisma.hotelTracker.findMany({ where: { active: true, nextCheckAt: { lte: new Date() } }, orderBy: { nextCheckAt: 'asc' }, take: 20 });
  for (const tracker of due) {
    try { validateHotelSearch(tracker.search); }
    catch (error) {
      await prisma.hotelTracker.update({ where: { id: tracker.id }, data: { active: false, lastError: errorText(error) } });
      continue;
    }
    await refreshHotelTracker(tracker.id, { userId: tracker.userId, isAdmin: true }, true);
  }
}
async function persistTrackerResult(tx: Prisma.TransactionClient, tracker: HotelTracker, run: HotelSearchRun, result: HotelSearchResult) {
  const selection = tracker.selection as unknown as HotelSelection;
  const options = tracker.options as unknown as HotelTrackingOptions;
  const offers = result.offers.flatMap(offer => {
    const match = matchHotelSelection(offer, selection, options.mode);
    return match ? [{ ...offer, match }] : [];
  });
  const eligible = offers.filter(o => o.match === 'exact' || options.allowApproximateAlerts);
  await tx.hotelSnapshot.createMany({ data: offers.map(offer => ({ trackerId: tracker.id, runId: run.id, offer: json(offer), eligible: offer.match === 'exact' || options.allowApproximateAlerts })) });
  const best = [...eligible].sort((a, b) => a.totalPrice - b.totalPrice)[0];
  const latest = [...offers].sort((a, b) => a.totalPrice - b.totalPrice)[0];
  // Approximate or missing offers cannot rearm an exact-match alert.
  await recordHotelAlerts(tx, tracker, best, result.errors.length === 0 && eligible.length === offers.length);
  const latestPrice = latest?.totalPrice ?? (result.completed === 0 && result.errors.length > 0 ? tracker.latestPrice : null);
  await tx.hotelTracker.update({ where: { id: tracker.id }, data: { latestPrice, lastCheckedAt: new Date(), lastError: result.errors.map(e => e.message).join('; ') || (offers.length ? null : 'No verified matching offers available'), nextCheckAt: new Date(Date.now() + options.scrapeInterval * 3_600_000) } });
}
async function claimHotelRun(run: HotelSearchRun, owner: string) {
  return prisma.$transaction(async tx => {
    if (!(await lockLease(tx, owner))) return false;
    if (run.trackerId) {
      const tracker = await lockHotelTracker(tx, run.trackerId);
      if (!tracker || tracker.userId !== run.userId) return false;
    }
    const claimed = await tx.hotelSearchRun.updateMany({ where: { id: run.id, status: 'queued' }, data: { status: 'running', claimedAt: new Date(), heartbeatAt: new Date() } });
    return claimed.count > 0;
  });
}
async function finishHotelRun(run: HotelSearchRun, owner: string, result: HotelSearchResult) {
  await prisma.$transaction(async tx => {
    if (!(await lockLease(tx, owner))) return;
    const tracker = run.trackerId ? await lockHotelTracker(tx, run.trackerId) : null;
    if (run.trackerId && (!tracker || tracker.userId !== run.userId)) return;
    // Locking the run serializes this entire commit with cancellation. No
    // cancelled/failed run can write snapshots, advance alerts, or resurrect.
    const current = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "HotelSearchRun" WHERE "id" = ${run.id} AND "status" = 'running' FOR UPDATE`;
    if (!current.length) return;
    if (tracker) await persistTrackerResult(tx, tracker, run, result);
    const status = result.errors.length ? result.completed ? 'partial' : 'failed' : result.offers.length ? 'success' : 'unavailable';
    await tx.hotelSearchRun.update({ where: { id: run.id }, data: { status, result: json(result), error: result.errors.map(e => `${e.source}: ${e.message}`).join('; ') || null, completedAt: new Date() } });
  });
}
async function failHotelRun(run: HotelSearchRun, owner: string, error: unknown) {
  await prisma.$transaction(async tx => {
    if (!(await lockLease(tx, owner))) return;
    const tracker = run.trackerId ? await lockHotelTracker(tx, run.trackerId) : null;
    if (run.trackerId && (!tracker || tracker.userId !== run.userId)) return;
    const changed = await tx.hotelSearchRun.updateMany({ where: { id: run.id, status: 'running' }, data: { status: 'failed', error: errorText(error), completedAt: new Date() } });
    if (changed.count && tracker) await tx.hotelTracker.update({ where: { id: tracker.id }, data: { lastError: errorText(error), lastCheckedAt: new Date(), nextCheckAt: new Date(Date.now() + 3_600_000) } });
  });
}
async function executeHotelRun(run: HotelSearchRun, owner: string) {
  const tracker = run.trackerId ? await prisma.hotelTracker.findUnique({ where: { id: run.trackerId } }) : null;
  const selection = tracker?.selection as unknown as HotelSelection | undefined;
  const search = validateHotelSearch(run.request);
  const stays = expandHotelStays(search);
  const result: HotelSearchResult = { offers: [], errors: [], completed: 0, total: stays.length * search.sources.length };
  for (const stay of stays) {
    for (const source of search.sources) {
      const [current, lease] = await Promise.all([prisma.hotelSearchRun.findUnique({ where: { id: run.id }, select: { status: true } }), prisma.hotelLease.findUnique({ where: { id: 'worker' } })]);
      if (current?.status !== 'running' || lease?.owner !== owner || lease.expiresAt < new Date()) return;
      try {
        const offers = await searchHotelSource(search, stay, source, selection);
        result.offers.push(...offers.filter(o => o.source === source && o.checkIn === stay.checkIn && o.checkOut === stay.checkOut && matchesHotelFilters(o, search, Boolean(tracker))));
        result.completed++;
      } catch (error) {
        if (error instanceof PartialHotelSourceError) {
          const offers = error.offers.filter(o => o.source === source && o.checkIn === stay.checkIn && o.checkOut === stay.checkOut && matchesHotelFilters(o, search, Boolean(tracker)));
          result.offers.push(...offers);
          if (offers.length) result.completed++;
        }
        result.errors.push({ source, ...stay, message: errorText(error) });
      }
      await prisma.$transaction(async tx => {
        if (!(await lockLease(tx, owner))) return;
        await tx.hotelSearchRun.updateMany({ where: { id: run.id, status: 'running' }, data: { result: json(result), heartbeatAt: new Date() } });
      });
    }
  }
  result.offers.sort((a, b) => a.totalPrice - b.totalPrice);
  await finishHotelRun(run, owner, result);
}

/** Database lease serializes timer, manual refresh, poll recovery and HTTP cron. */
export async function pumpHotelJobs() {
  if (process.env.SELF_HOSTED !== 'true') return;
  const config = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } });
  if (config?.enabled === false) return;
  const owner = randomUUID();
  if (!(await acquireLease(owner))) return;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void prisma.hotelLease.updateMany({ where: { id: 'worker', owner }, data: { expiresAt: new Date(Date.now() + LEASE_MS) } }).then(r => { if (!r.count) leaseLost = true; }).catch(error => { leaseLost = true; console.error('[hotels] Lease heartbeat failed:', errorText(error)); });
  }, 20_000);
  heartbeat.unref();
  try {
    // The prior owner no longer holds a lease; its in-progress observations are incomplete.
    await prisma.$transaction(async tx => {
      if (!(await lockLease(tx, owner))) return;
      await tx.hotelSearchRun.updateMany({ where: { status: 'running' }, data: { status: 'failed', error: 'Hotel worker interrupted; refresh to retry', completedAt: new Date() } });
    });
    await prisma.hotelSearchRun.deleteMany({ where: { trackerId: null, status: { notIn: ACTIVE }, createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
    await scheduleDue();
    const jobs = await prisma.hotelSearchRun.findMany({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, take: 3 });
    for (const job of jobs) {
      if (leaseLost) break;
      if (!(await claimHotelRun(job, owner))) continue;
      try { await executeHotelRun(job, owner); }
      catch (error) {
        await failHotelRun(job, owner, error);
      }
    }
    if (!leaseLost) await deliverHotelAlerts();
  } finally {
    clearInterval(heartbeat);
    await prisma.hotelLease.updateMany({ where: { id: 'worker', owner }, data: { expiresAt: new Date(0) } });
  }
}

export async function runHotelJobsSafely() {
  try { await pumpHotelJobs(); }
  catch (error) { console.error('[hotels] Worker failed:', errorText(error)); }
}
