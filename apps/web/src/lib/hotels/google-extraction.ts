import { createHash } from 'node:crypto';
import { verifyHotelContext, type HotelPageCapture } from './extraction';
import type { HotelOffer, HotelSearch, HotelStay } from './types';
import { hotelAmenities } from './property-metadata';

/** The provider's selected total-price mode applies to the visible seller rows. */
export function extractGoogleOffers(capture: HotelPageCapture, search: HotelSearch, stay: HotelStay): HotelOffer[] {
  verifyHotelContext(capture, search, stay, 'google_hotels');
  if (/no availability (?:for|on) (?:your|these|the selected) dates|not available (?:for|on) (?:your|these|the selected) dates/i.test(capture.text.slice(0, 2500))) return [];
  const nights = Math.round((Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000);
  if (!new RegExp(`Stay totalPrice for ${nights} nights? with taxes \\+ fees`).test(capture.totalPriceBasis ?? '') || !capture.controls.includes('Stay total')) throw new Error('Google Hotels did not verify stay total including taxes and fees');
  const entity = capture.links.find(link => new URL(link.url).pathname.includes('/hotels/entity/') && /^Open .* in a new tab/.test(link.text));
  const propertyUrl = new URL(capture.url).pathname.includes('/hotels/entity/') ? capture.url : entity?.url;
  const hotelName = entity?.text.replace(/^Open /, '').replace(/ in a new tab\.?$/, '') || (new URL(capture.url).pathname.includes('/hotels/entity/') ? capture.propertyName : undefined);
  if (!propertyUrl || !hotelName) throw new Error('Google Hotels did not provide a stable hotel identity');
  const propertyId = `google_hotels:${new URL(propertyUrl).pathname}`;
  const currencyMarkers: Record<string, string> = { USD: 'US$', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$' };
  const marker = currencyMarkers[search.currency] ?? search.currency;
  if (!capture.text.includes(marker) && !capture.controls.includes(`Currency\u200b${search.currency}`)) throw new Error('Google Hotels did not verify selected currency');
  const money = search.currency === 'USD' ? /(?:US\$|\$)([\d,]+(?:\.\d{1,2})?)/g : new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\d,]+(?:\\.\\d{1,2})?)`, 'g');
  const seen = new Set<string>();
  const offers: HotelOffer[] = [];
  for (const link of capture.links) {
    if (!link.seller || !link.text.includes('Visit site') || /members?[- ]only|membership|sign in/i.test(link.text)) continue;
    const prices = [...link.text.matchAll(money)];
    if (prices.length !== 1) continue;
    const price = Number(prices[0]![1]!.replaceAll(',', ''));
    if (!Number.isFinite(price) || price <= 0) continue;
    const firstLine = link.text.split('\n')[0]?.trim();
    const roomName = firstLine && firstLine !== link.seller ? firstLine : null;
    const refundable = /Free cancellation/i.test(link.text) ? true : /Non-refundable/i.test(link.text) ? false : null;
    const breakfast = /breakfast included|free breakfast/i.test(link.text) ? true : null;
    const key = JSON.stringify([propertyId, link.seller, roomName, refundable, breakfast]);
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({
      id: createHash('sha256').update(JSON.stringify([key, stay, search.rooms])).digest('hex').slice(0, 24),
      source: 'google_hotels', propertyId, hotelName, address: capture.address ?? '',
      imageUrl: capture.images[0]?.url ?? null, propertyUrl, bookingUrl: link.url, seller: link.seller,
      ...stay, roomName, rateName: null, totalPrice: price, currency: search.currency,
      taxesIncluded: true, occupancyVerified: true, rooms: search.rooms, refundable, breakfast,
      stars: Number(capture.text.slice(0, 1000).match(/([1-5])-star hotel/)?.[1]) || null,
      rating: (() => { const rating = Number(capture.text.slice(0, 1200).match(/\n(\d(?:\.\d)?)\n(?:Excellent|Very good|Good|Fair|Poor)/)?.[1]); return rating > 0 && rating <= 5 ? rating * 2 : null; })(),
      amenities: hotelAmenities(capture.text.match(/(?:Popular amenities|Hotel amenities|Amenities)\n([\s\S]*?)(?:View more hotel details|Web results|Sponsored|$)/i)?.[1] ?? ''), match: 'approximate',
    });
  }
  if (!offers.length) throw new Error('Google Hotels did not render verifiable public seller totals');
  return offers;
}
