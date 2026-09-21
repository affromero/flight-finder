import { randomUUID } from 'node:crypto';
import type { Prisma, TravelAlertDelivery } from '@/generated/prisma/client';
import { notificationTransaction } from '../notifications/database';
import { deliverClaimedAlert, DELIVERY_CLAIM_MS, type ClaimedDelivery } from '../notifications/delivery';
import type { ChannelMessage } from '../notifications/channels/types';
import { json, lockHotelTracker } from './store';

interface HotelDelivery extends ClaimedDelivery { trackerId: string; hotelAlertId: string }
async function claim(id: string, trackerId: string): Promise<HotelDelivery | null> {
  return notificationTransaction(async tx => {
    const tracker = await lockHotelTracker(tx, trackerId);
    const alert = await tx.hotelAlert.findUnique({ where: { id } });
    if (!tracker?.active || !alert?.pending || alert.trackerId !== trackerId || alert.nextAttemptAt > new Date()) return null;
    // Existing events retain their payload and successful receipts on upgrade.
    const message = alert.message as unknown as ChannelMessage;
    const row = await tx.travelAlertDelivery.upsert({ where: { hotelAlertId: id }, update: {}, create: {
      hotelAlertId: id, eventKey: `hotel:${id}`, deliveredIds: alert.deliveredIds, nextAttemptAt: alert.nextAttemptAt,
      message: json({ ...message, data: { ...message.data, deliveryOwner: tracker.userId } }),
    } });
    if (!row.pending || (row.claimExpiresAt && row.claimExpiresAt > new Date())) return null;
    const payload = row.message as unknown as ChannelMessage;
    if (payload.data?.deliveryOwner !== tracker.userId) {
      await tx.travelAlertDelivery.update({ where: { id: row.id }, data: { pending: false, claimToken: null, claimExpiresAt: null } });
      await tx.hotelAlert.update({ where: { id }, data: { pending: false } });
      return null;
    }
    const expires = new Date(Date.now() + DELIVERY_CLAIM_MS);
    const claimed = await tx.travelAlertDelivery.update({ where: { id: row.id }, data: { claimToken: randomUUID(), claimExpiresAt: expires, nextAttemptAt: expires } });
    await tx.hotelAlert.update({ where: { id }, data: { nextAttemptAt: expires } });
    return { ...claimed, hotelAlertId: id, trackerId, owner: tracker.userId, payload };
  });
}
async function guarded<T>(entry: HotelDelivery, work: (tx: Prisma.TransactionClient, row: TravelAlertDelivery) => Promise<T>): Promise<T> {
  return notificationTransaction(async tx => {
    const tracker = await lockHotelTracker(tx, entry.trackerId);
    const alert = await tx.hotelAlert.findUnique({ where: { id: entry.hotelAlertId } });
    const row = await tx.travelAlertDelivery.findUnique({ where: { id: entry.id } });
    if (!tracker?.active || tracker.userId !== entry.owner || !alert?.pending || !row?.pending
      || row.claimToken !== entry.claimToken || !row.claimExpiresAt || row.claimExpiresAt <= new Date()) throw new Error('Hotel notification delivery authority was lost');
    return work(tx, row);
  });
}
export async function deliverHotelAlerts(signal?: AbortSignal): Promise<void> {
  const alerts = await notificationTransaction(tx => tx.hotelAlert.findMany({ where: { pending: true, nextAttemptAt: { lte: new Date() }, tracker: { active: true } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 50 }), signal);
  for (const alert of alerts) {
    if (signal?.aborted) return;
    try {
      const entry = await claim(alert.id, alert.trackerId);
      if (!entry) continue;
      await deliverClaimedAlert(entry, work => guarded(entry, work), signal, async (tx, row) => {
        await tx.hotelAlert.update({ where: { id: entry.hotelAlertId }, data: {
          pending: row.pending, deliveredIds: row.deliveredIds, nextAttemptAt: row.nextAttemptAt, lastError: row.lastError,
        } });
      });
    } catch (error) { console.error('[hotels] Notification delivery did not complete:', error instanceof Error ? error.message : 'Unknown error'); }
  }
}
