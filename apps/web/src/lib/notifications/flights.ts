import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, Query, TravelAlertDelivery } from '@/generated/prisma/client';
import { lockTravelAdmission } from '../travel/admission';
import { notificationTransaction } from './database';
import { detectNewLow } from './detect';
import { formatNewLowMessage } from './format';
import { deliverClaimedAlert, DELIVERY_CLAIM_MS, type ClaimedDelivery } from './delivery';
import type { ChannelMessage } from './channels/types';
import { resolveBaseUrl } from './base-url';

interface FlightDelivery extends ClaimedDelivery { queryId: string; queryVersion: string; price: number }
function criteriaVersion(query: Query): string {
  const metadata = new Set(['updatedAt', 'firstViewedAt', 'lastNotifiedLowPrice', 'lastNotifiedAt']);
  const criteria = Object.entries(query).filter(([key]) => !metadata.has(key)).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(criteria)).digest('hex');
}
async function lockQuery(tx: Prisma.TransactionClient, id: string) {
  await lockTravelAdmission(tx);
  await tx.$queryRaw`SELECT id FROM "Query" WHERE id = ${id} FOR UPDATE`;
  return tx.query.findUnique({ where: { id } });
}

async function flightAlertOptions(tx: Prisma.TransactionClient, cycleStartedAt: Date) {
  await lockTravelAdmission(tx);
  let config = await tx.extractionConfig.findUnique({ where: { id: 'singleton' } });
  if (config && config.cabinAlertBaselineCutoff === null) {
    // This transaction also contains the first corrected observation. Use its
    // cycle boundary so PostgreSQL transaction timestamps stay after the cutoff.
    await tx.extractionConfig.updateMany({ where: { id: 'singleton', cabinAlertBaselineCutoff: null }, data: { cabinAlertBaselineCutoff: cycleStartedAt } });
    config = await tx.extractionConfig.findUnique({ where: { id: 'singleton' } });
  }
  return { floorAbs: config?.notifyMinDropAbs ?? 5, floorPct: config?.notifyMinDropPct ?? 0,
    baselineCutoff: config?.cabinAlertBaselineCutoff ?? null, baseUrl: resolveBaseUrl(config?.publicBaseUrl) };
}

/** Price observations and their outbox event must commit together. */
export async function recordFlightAlertInTransaction(tx: Prisma.TransactionClient, queryId: string, cycleStartedAt: Date): Promise<void> {
  const options = await flightAlertOptions(tx, cycleStartedAt);
  const query = await lockQuery(tx, queryId);
  if (!query?.active || query.expiresAt <= new Date()) return;
  if (query.cabinClass !== 'economy' && options.baselineCutoff && query.lastNotifiedLowPrice !== null
    && (!query.lastNotifiedAt || query.lastNotifiedAt < options.baselineCutoff)) {
    // Reset only the locked query. Locking siblings here would invert grouped
    // user edits, and delivery metadata must preserve scraper criteria authority.
    await tx.query.update({ where: { id: queryId }, data: { lastNotifiedLowPrice: null, lastNotifiedAt: null, updatedAt: query.updatedAt } });
  }
  const edit = await tx.queryEditEvent.findFirst({ where: { queryId }, orderBy: { editedAt: 'desc' }, select: { editedAt: true } });
  const boundaries = [edit?.editedAt, query.cabinClass !== 'economy' ? options.baselineCutoff : null].filter((date): date is Date => Boolean(date));
  const baselineFrom = boundaries.length ? new Date(Math.max(...boundaries.map(date => date.getTime()))) : null;
  // Legacy notification markers have no currency or criteria identity. The
  // outbox deduplicates events; only matching observations define their low.
  const alert = await detectNewLow({ query: { ...query, lastNotifiedLowPrice: null }, cycleStartedAt, floorAbs: options.floorAbs, floorPct: options.floorPct, baselineFrom }, tx);
  if (!alert) return;
  const queryVersion = criteriaVersion(query);
  const key = createHash('sha256').update(JSON.stringify([query.id, query.userId, queryVersion, alert.currency, alert.currentMin])).digest('hex');
  const message = formatNewLowMessage({ alert, route: query, baseUrl: options.baseUrl });
  await tx.travelAlertDelivery.upsert({ where: { eventKey: `flight:${key}` }, update: {}, create: {
    queryId, eventKey: `flight:${key}`, message: JSON.parse(JSON.stringify({ ...message, data: { ...message.data, userId: query.userId, queryVersion } })),
  } });
}

/** Retained for post-scrape callers; the stable event key makes this idempotent. */
export async function recordFlightAlert(queryId: string, cycleStartedAt: Date): Promise<void> {
  await notificationTransaction(tx => recordFlightAlertInTransaction(tx, queryId, cycleStartedAt));
}

function flightPayload(row: TravelAlertDelivery): { payload: ChannelMessage; owner: string | null; queryVersion: string; price: number } {
  const message = row.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid flight notification');
  const data = message.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.queryId !== row.queryId
    || (data.userId !== null && typeof data.userId !== 'string') || typeof data.queryVersion !== 'string'
    || typeof data.currentMin !== 'number' || !Number.isFinite(data.currentMin) || data.currentMin <= 0
    || typeof message.title !== 'string' || typeof message.body !== 'string' || typeof message.url !== 'string') throw new Error('Invalid flight notification');
  return { payload: message as unknown as ChannelMessage, owner: data.userId, queryVersion: data.queryVersion, price: data.currentMin };
}

async function claim(id: string, queryId: string): Promise<FlightDelivery | null> {
  return notificationTransaction(async tx => {
    const query = await lockQuery(tx, queryId);
    const row = await tx.travelAlertDelivery.findUnique({ where: { id } });
    if (!row?.pending || row.queryId !== queryId || row.nextAttemptAt > new Date() || (row.claimExpiresAt && row.claimExpiresAt > new Date())) return null;
    let details: ReturnType<typeof flightPayload>;
    try {
      details = flightPayload(row);
      if (!query?.active || query.expiresAt <= new Date() || query.userId !== details.owner || criteriaVersion(query) !== details.queryVersion) throw new Error('Flight query changed');
    } catch {
      await tx.travelAlertDelivery.update({ where: { id }, data: { pending: false, claimToken: null, claimExpiresAt: null, lastError: 'Notification cancelled: its query or stored event is no longer valid.' } });
      return null;
    }
    const expires = new Date(Date.now() + DELIVERY_CLAIM_MS);
    const claimed = await tx.travelAlertDelivery.update({ where: { id }, data: { claimToken: randomUUID(), claimExpiresAt: expires, nextAttemptAt: expires } });
    return { ...claimed, ...details, queryId };
  });
}
async function guarded<T>(entry: FlightDelivery, work: (tx: Prisma.TransactionClient, row: TravelAlertDelivery) => Promise<T>): Promise<T> {
  return notificationTransaction(async tx => {
    const query = await lockQuery(tx, entry.queryId);
    const row = await tx.travelAlertDelivery.findUnique({ where: { id: entry.id } });
    if (!query?.active || query.expiresAt <= new Date() || query.userId !== entry.owner || criteriaVersion(query) !== entry.queryVersion
      || !row?.pending || row.claimToken !== entry.claimToken || !row.claimExpiresAt || row.claimExpiresAt <= new Date()) throw new Error('Flight notification delivery authority was lost');
    return work(tx, row);
  });
}

export async function deliverFlightAlerts(signal?: AbortSignal): Promise<void> {
  const rows = await notificationTransaction(tx => tx.travelAlertDelivery.findMany({ where: { queryId: { not: null }, pending: true, nextAttemptAt: { lte: new Date() } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 20 }), signal);
  for (const row of rows) {
    if (signal?.aborted) return;
    try {
      const entry = await claim(row.id, row.queryId!);
      if (!entry) continue;
      await deliverClaimedAlert(entry, work => guarded(entry, work), signal, async (tx, updated) => {
        if (!updated.deliveredIds.length) return;
        // Delivery metadata is not a criteria edit. Preserve the criteria version
        // used by flight result commits and pending notification guards.
        const query = await tx.query.findUniqueOrThrow({ where: { id: entry.queryId } });
        await tx.query.updateMany({ where: { id: entry.queryId, OR: [{ lastNotifiedLowPrice: null }, { lastNotifiedLowPrice: { gt: entry.price } }] },
          data: { lastNotifiedLowPrice: entry.price, lastNotifiedAt: new Date(), updatedAt: query.updatedAt } });
      });
    } catch (error) { console.error('[notify] Flight notification delivery did not complete:', error instanceof Error ? error.message : 'Unknown error'); }
  }
}
