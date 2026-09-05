import { prisma } from '@/lib/prisma';
import { dispatchNotifications } from '@/lib/notifications/notify';
import type { ChannelMessage } from '@/lib/notifications/channels/types';
import { resolveBaseUrl } from '@/lib/notifications/run';
import { safeHttpUrl } from '@/lib/safe-url';
import { evaluateHotelAlerts } from './domain';
import { json, lockHotelTracker } from './store';
import type { HotelTracker, Prisma } from '@/generated/prisma/client';
import type { HotelOffer, HotelTrackingOptions } from './types';

export async function recordHotelAlerts(tx: Prisma.TransactionClient, tracker: HotelTracker, offer: HotelOffer | undefined, complete: boolean) {
  if (!offer || !tracker.active) return;
  const options = tracker.options as unknown as HotelTrackingOptions;
  const outcome = evaluateHotelAlerts({ targetArmed: tracker.targetArmed, historicalLow: tracker.historicalLow === null ? null : Number(tracker.historicalLow) }, options, offer.totalPrice, complete);
  const config = await tx.extractionConfig.findUnique({ where: { id: 'singleton' } });
  const base = resolveBaseUrl(config?.publicBaseUrl);
  const url = base ? `${base}/hotels/${tracker.id}` : safeHttpUrl(offer.bookingUrl);
  const amount = new Intl.NumberFormat('en', { style: 'currency', currency: offer.currency }).format(offer.totalPrice);
  const message: ChannelMessage = {
    title: `${outcome.target ? 'Hotel target reached' : 'New hotel low'}: ${tracker.hotelName}`,
    body: `${tracker.hotelName}: ${amount} total including taxes and fees. ${offer.checkIn} to ${offer.checkOut}, ${offer.rooms.length} room(s). ${offer.seller}.${offer.match === 'approximate' ? ' Approximate room/rate match; verify conditions before booking.' : ''}`,
    url,
    data: { trackerId: tracker.id, price: offer.totalPrice, currency: offer.currency, checkIn: offer.checkIn, checkOut: offer.checkOut, target: outcome.target, newLow: outcome.low, approximate: offer.match === 'approximate' },
  };
  await tx.hotelTracker.update({ where: { id: tracker.id }, data: outcome.state });
  if (outcome.target || outcome.low) await tx.hotelAlert.create({ data: { trackerId: tracker.id, message: json(message) } });
}

export async function deliverHotelAlerts() {
  const alerts = await prisma.hotelAlert.findMany({ where: { pending: true, nextAttemptAt: { lte: new Date() }, tracker: { active: true } }, orderBy: { nextAttemptAt: 'asc' }, take: 50 });
  for (const alert of alerts) {
    try {
      // The claim follows the same tracker lock as pause/reassignment so stale
      // rows from the batch cannot deliver cancelled events or old ownership.
      const claimed = await prisma.$transaction(async tx => {
        const tracker = await lockHotelTracker(tx, alert.trackerId);
        if (!tracker?.active) return null;
        const claim = await tx.hotelAlert.updateMany({ where: { id: alert.id, pending: true, nextAttemptAt: { lte: new Date() } }, data: { nextAttemptAt: new Date(Date.now() + 300_000) } });
        if (!claim.count) return null;
        const current = await tx.hotelAlert.findUnique({ where: { id: alert.id } });
        return current ? { ...current, userId: tracker.userId } : null;
      });
      if (!claimed) continue;
      const outcomes = await dispatchNotifications(claimed.userId, claimed.message as unknown as ChannelMessage, claimed.deliveredIds);
      const deliveredIds = [...new Set([...claimed.deliveredIds, ...outcomes.filter(o => o.ok).map(o => o.channelId)])];
      // With no channels configured, retain the event until a channel exists.
      const pending = outcomes.some(o => !o.ok) || (outcomes.length === 0 && deliveredIds.length === 0);
      await prisma.hotelAlert.updateMany({ where: { id: alert.id, pending: true }, data: { deliveredIds, pending, lastError: outcomes.filter(o => !o.ok).map(o => o.error).join('; ') || null } });
    } catch (error) {
      await prisma.hotelAlert.updateMany({ where: { id: alert.id, pending: true }, data: { lastError: error instanceof Error ? error.message : String(error), nextAttemptAt: new Date(Date.now() + 300_000) } });
    }
  }
}
