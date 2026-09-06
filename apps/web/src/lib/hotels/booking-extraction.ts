import { createHash } from 'node:crypto';
import { verifyHotelContext, type HotelPageCapture } from './extraction';
import type { HotelOffer, HotelRoom, HotelSearch, HotelSelection, HotelStay } from './types';
import { hotelAmenities } from './property-metadata';

type CapturedRate = NonNullable<HotelPageCapture['rates']>[number];
interface PricedRoom { rate: CapturedRate; price: number; refundable: boolean | null; breakfast: boolean | null }

function priceRate(rate: CapturedRate, room: HotelRoom, search: HotelSearch, stay: HotelStay): PricedRoom | null {
  if (/members?[- ]only|sign in (?:for|to)|requires? (?:a )?membership/i.test(rate.text)) return null;
  const occupancy = `${rate.text}\n${rate.occupancy ?? ''}`.replace(/<[^>]+>/g, ' ');
  const adults = Number(occupancy.match(/Max (?:adults|persons):\s*(\d+)/i)?.[1] ?? occupancy.match(/Sleeps:\s*(\d+) adults?/i)?.[1] ?? 0);
  const children = Number(occupancy.match(/Max children:\s*(\d+)/i)?.[1] ?? 0);
  if (adults < room.adults || children < room.children.length || !rate.available) return null;
  if (room.children.length && !/Free stay for your child/i.test(rate.text)) return null;
  const nights = Math.round((Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000);
  const headerNights = rate.priceBasis?.match(/\bPrice for (\d+) nights?\b/i)?.[1];
  if (rate.priceBasis && (Number(headerNights) !== nights || /\b(?:per|each) night\b|nightly/i.test(rate.priceBasis))) return null;
  if (!headerNights && !new RegExp(`\\b${nights} nights?\\b`).test(rate.text)) return null;
  const currencies: Record<string, string> = { USD: '(?:US\\$|\\$)', GBP: '£', EUR: '€', CAD: 'CAD', AUD: 'AUD' };
  const symbol = currencies[search.currency] ?? search.currency;
  const current = rate.text.match(new RegExp(`Current price\\s*${symbol}\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'));
  const priceLine = rate.text.match(new RegExp(`(?:^|\\n)${symbol}\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:\\n|$)`, 'i'));
  const amount = current?.[1] ?? priceLine?.[1];
  if (!amount) return null;
  let price = Number(amount.replaceAll(',', ''));
  const excluded = rate.text.match(/Excluded:\s*([^\n]+)/i)?.[1]?.trim();
  if (excluded) {
    const percent = excluded.match(/^(\d+(?:\.\d+)?)\s*%\s*VAT$/i)?.[1];
    if (!percent || /(?:city|resort|tourism|cleaning|service)\s*(?:tax|fee|charge)/i.test(rate.text)) return null;
    price = Math.round(price * (1 + Number(percent) / 100) * 100) / 100;
  } else if (!/(?:includes?|included)[^\n]*(?:tax|VAT)|(?:taxes|VAT)[^\n]*included/i.test(rate.text)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const refundable = /Non-refundable/i.test(rate.text) ? false : /Free cancellation/i.test(rate.text) ? true : null;
  const breakfast = /breakfast included/i.test(rate.text) ? true : /breakfast\s+(?:US\$|\$|£|€|[A-Z]{3})\s*\d/i.test(rate.text) ? false : null;
  return { rate, price, refundable, breakfast };
}

/** Structured Booking table rows are the source of rate identity and price, without model inference. */
export function extractBookingOffers(capture: HotelPageCapture, search: HotelSearch, stay: HotelStay, selection?: HotelSelection): HotelOffer[] {
  verifyHotelContext(capture, search, stay, 'booking');
  if (/no availability (?:for|on) (?:your|these|the selected) dates|not available (?:for|on) (?:your|these|the selected) dates|sold out (?:for|on) (?:your|these|the selected) dates/i.test(capture.text)) return [];
  if (!capture.propertyName || !capture.rates?.length) throw new Error('Booking.com did not render a supported property rate table');
  const hotelName = capture.propertyName.replace(/\s+\(Hotel\)\s+\([A-Z]{2,3}\)\s+deals$/i, '');
  const candidates = search.rooms.map(room => capture.rates!.map(rate => priceRate(rate, room, search, stay)).filter((rate): rate is PricedRoom => rate !== null).sort((a, b) => a.price - b.price));
  if (candidates.some(rates => !rates.length)) throw new Error('Booking.com did not verify tax-inclusive rates for every requested room');
  // Keep policy and room alternatives, bounded to prevent a room Cartesian explosion.
  const alternatives = candidates.map(rates => {
    const seen = new Set<string>();
    return rates.filter(rate => {
      const key = `${rate.rate.roomName}:${rate.refundable}:${rate.breakfast}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
  });
  let combinations: PricedRoom[][] = [[]];
  const available = (combination: PricedRoom[]) => combination.every(room => combination.filter(other => other.rate.id.split('_')[0] === room.rate.id.split('_')[0]).length <= (room.rate.available ?? 0));
  for (const rooms of alternatives) combinations = combinations.flatMap(combination => rooms.map(room => [...combination, room])).filter(available).sort((a, b) => a.reduce((sum, room) => sum + room.price, 0) - b.reduce((sum, room) => sum + room.price, 0)).slice(0, 128);
  if (selection?.providerRateId) {
    const ids = selection.providerRateId.split('+');
    const selected = candidates.map((rooms, index) => rooms.find(room => room.rate.id === ids[index]));
    if (selected.length === ids.length && selected.every((room): room is PricedRoom => Boolean(room)) && available(selected) && !combinations.some(rooms => rooms.map(room => room.rate.id).join('+') === selection.providerRateId)) combinations.push(selected);
  }
  const url = new URL(capture.url);
  for (const key of ['sid', 'label', 'aid', 'chal_t', 'force_referer']) url.searchParams.delete(key);
  const propertyId = `booking:${url.pathname.replace(/\.en-gb\.html$/, '.html')}`;
  return combinations.map(combination => {
    const providerRateId = combination.map(room => room.rate.id).join('+');
    const refundable = combination.every(room => room.refundable === true) ? true : combination.some(room => room.refundable === false) ? false : null;
    const breakfast = combination.every(room => room.breakfast === true) ? true : combination.some(room => room.breakfast === false) ? false : null;
    const roomName = combination.map(room => room.rate.roomName).join(' + ');
    const rateName = `${refundable === true ? 'Free cancellation' : refundable === false ? 'Non-refundable' : 'Cancellation unverified'} · ${breakfast === true ? 'Breakfast included' : breakfast === false ? 'Breakfast extra' : 'Breakfast unverified'}`;
    return {
      id: createHash('sha256').update(JSON.stringify([propertyId, providerRateId, stay, search.rooms])).digest('hex').slice(0, 24),
      source: 'booking', propertyId, providerRateId, hotelName, address: capture.address ?? '',
      propertyUrl: url.href, bookingUrl: url.href, imageUrl: capture.images[0]?.url ?? null, seller: 'Booking.com',
      ...stay, roomName, rateName, rooms: search.rooms, totalPrice: Math.round(combination.reduce((sum, room) => sum + room.price, 0) * 100) / 100,
      currency: search.currency, taxesIncluded: true, occupancyVerified: true, refundable, breakfast,
      stars: Number(capture.starsLabel?.match(/([1-5]) (?:out of 5|stars)/i)?.[1]) || null, rating: Number(capture.text.match(/Scored (\d+(?:\.\d+)?)/)?.[1]) || null,
      amenities: hotelAmenities(capture.text.includes('Facilities of') ? capture.text.slice(capture.text.indexOf('Facilities of'), capture.text.indexOf('The fine print') > 0 ? capture.text.indexOf('The fine print') : undefined) : ''), match: refundable !== null && breakfast !== null ? 'exact' : 'approximate',
    };
  });
}
