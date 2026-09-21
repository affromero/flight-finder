import { randomUUID } from 'node:crypto';
import type { Prisma, TravelAlertDelivery } from '@/generated/prisma/client';
import { deliverClaimedAlert, DELIVERY_CLAIM_MS } from '../notifications/delivery';
import type { ChannelMessage } from '../notifications/channels/types';
import { lockCarTrackerRow } from './store';
import { carInteger, carRecord, carText } from './validation';
import { carProviderUrl } from './offer-validation';
import { validateCarMoney } from './money';
import { notificationTransaction } from '../notifications/database';

type Claimed = TravelAlertDelivery & { carTrackerId: string; claimToken: string; owner: string | null; revision: number; payload: ChannelMessage };

function payload(raw: unknown, trackerId: string, owner: string | null, revision: number): ChannelMessage {
  const message = carRecord(raw), data = carRecord(message.data);
  if (data.trackerId !== trackerId || data.userId !== owner || data.trackerRevision !== revision) throw new Error('Notification belongs to an earlier tracker owner or revision');
  if ((data.source !== 'discovercars' && data.source !== 'autoeurope') || typeof data.target !== 'boolean' || typeof data.newLow !== 'boolean' || (!data.target && !data.newLow)) throw new Error('Stored car notification is invalid');
  const source = data.source;
  const price = validateCarMoney({ currency: data.currency, minor: data.totalMinor });
  if (price.minor === 0) throw new Error('Stored car notification has no verified price');
  return {
    title: carText(message.title, 600, 'notification title'), body: carText(message.body, 6000, 'notification body'),
    url: carProviderUrl(message.url, source),
    data: { trackerId, userId: owner, trackerRevision: carInteger(revision, 0, 2_147_483_647, 'tracker revision'), source, totalMinor: price.minor, currency: price.currency, target: data.target, newLow: data.newLow },
  };
}

async function claim(id: string, trackerId: string): Promise<Claimed | null> {
  return notificationTransaction(async tx => {
    const tracker = await lockCarTrackerRow(tx, trackerId);
    const row = await tx.travelAlertDelivery.findUnique({ where: { id } });
    if (!row?.pending || row.carTrackerId !== trackerId || row.nextAttemptAt > new Date() || (row.claimExpiresAt && row.claimExpiresAt > new Date())) return null;
    let message: ChannelMessage;
    try {
      if (!tracker.active) throw new Error('Car tracker is paused');
      message = payload(row.message, trackerId, tracker.userId, tracker.revision);
    } catch {
      await tx.travelAlertDelivery.update({ where: { id }, data: { pending: false, claimToken: null, claimExpiresAt: null, lastError: 'Notification cancelled: its tracker or stored event is no longer valid.' } });
      return null;
    }
    const token = randomUUID(), expires = new Date(Date.now() + DELIVERY_CLAIM_MS);
    const updated = await tx.travelAlertDelivery.update({ where: { id }, data: { claimToken: token, claimExpiresAt: expires, nextAttemptAt: expires } });
    return { ...updated, carTrackerId: trackerId, claimToken: token, owner: tracker.userId, revision: tracker.revision, payload: message };
  });
}

async function guarded<T>(entry: Claimed, write: (tx: Prisma.TransactionClient, row: TravelAlertDelivery) => Promise<T>): Promise<T> {
  return notificationTransaction(async tx => {
    const tracker = await lockCarTrackerRow(tx, entry.carTrackerId);
    const row = await tx.travelAlertDelivery.findUnique({ where: { id: entry.id } });
    if (!tracker.active || tracker.userId !== entry.owner || tracker.revision !== entry.revision || !row?.pending || row.claimToken !== entry.claimToken || !row.claimExpiresAt || row.claimExpiresAt <= new Date()) throw new Error('Car notification delivery authority was lost');
    return write(tx, row);
  });
}

async function deliver(entry: Claimed, parent?: AbortSignal): Promise<void> {
  await deliverClaimedAlert(entry, work => guarded(entry, work), parent);
}

/** External delivery is at least once: acceptance followed by a lost receipt may repeat. */
export async function deliverCarAlerts(signal?: AbortSignal): Promise<void> {
  if (process.env.SELF_HOSTED !== 'true') return;
  const rows = await notificationTransaction(tx => tx.travelAlertDelivery.findMany({ where: { carTrackerId: { not: null }, pending: true, nextAttemptAt: { lte: new Date() } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 20 }), signal);
  for (const row of rows) {
    if (signal?.aborted) return;
    try { const entry = await claim(row.id, row.carTrackerId!); if (entry) await deliver(entry, signal); }
    catch (error) { console.error('[cars] Notification delivery did not complete:', error instanceof Error ? error.message : 'Unknown error'); }
  }
}
