import type { ChannelMessage } from '@/lib/notifications/channels/types';
import { resolveBaseUrl } from '@/lib/notifications/run';
import { safeHttpUrl } from '@/lib/safe-url';
import { evaluateHotelAlerts } from './domain';
import { json } from './store';
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


export { deliverHotelAlerts } from './delivery';
