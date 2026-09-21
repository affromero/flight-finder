import { travelImportUrl, type ImportKind } from './import-url';
import { flightLinkQuery } from '../scraper/flight-link';
import { googleSelectedDates } from '../hotels/google';
import type { HotelSearch, HotelSource } from '../hotels/types';
import { validateCarParseDraft, type CarParseDraft } from '../cars/parse-draft';
import type { CarSource } from '../cars/types';

export function importTravelDraft(raw: unknown, kind: ImportKind) {
  const imported = travelImportUrl(raw, kind), url = new URL(imported.url), query = url.searchParams;
  if (kind === 'flights') return { kind, url: imported.url, flight: flightLinkQuery(imported.url) };
  if (kind === 'hotels') {
    const dates = imported.source === 'google_hotels' ? googleSelectedDates(imported.url) : [query.get('checkin'), query.get('checkout')];
    const hotel: Partial<HotelSearch> = { sourceUrl: imported.url, sources: [imported.source as HotelSource], dateMode: 'fixed', flexibility: 0 };
    if (dates[0]) hotel.checkIn = dates[0];
    if (dates[1]) hotel.checkOut = dates[1];
    if (imported.source === 'booking') hotel.destination = url.pathname.split('/').at(-1)!.replace(/(?:\.[a-z-]+)?\.html$/, '').replace(/-/g, ' ');
    const currency = query.get('selected_currency') ?? query.get('curr');
    if (currency && Intl.supportedValuesOf('currency').includes(currency)) hotel.currency = currency;
    // Multi-room allocation and children must be explicitly reviewed in the form.
    const adults = Number(query.get('group_adults')), rooms = Number(query.get('no_rooms'));
    const children = Number(query.get('group_children') ?? 0), ages = query.getAll('age').map(Number);
    if (rooms === 1 && adults >= 1 && adults <= 6 && children === ages.length && ages.every(age => Number.isInteger(age) && age >= 0 && age <= 17)) hotel.rooms = [{ adults, children: ages }];
    return { kind, url: imported.url, hotel };
  }
  let data: Record<string, unknown> = {};
  if (imported.source === 'discovercars') {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.get('sq')!, 'base64').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      data = value as Record<string, unknown>;
    } catch { throw new Error('The rental link contains invalid search details'); }
  }
  const datetime = (value: unknown) => {
    const match = typeof value === 'string' ? value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00)?$/) : null;
    return { date: match?.[1] ?? null, time: match?.[2] ?? null };
  };
  const source = imported.source as CarSource;
  const driverAge = source === 'discovercars' ? data.DriverAge : query.get('drivers_age');
  const residence = source === 'discovercars' ? data.ResidenceCountry : query.get('residence_country');
  const pickupId = source === 'discovercars' ? data.PickupLocationId : query.get('pickup_location');
  const dropoffId = source === 'discovercars' ? data.DropOffLocationId : query.get('dropoff_location');
  const car: CarParseDraft = validateCarParseDraft({
    sameLocation: pickupId != null && dropoffId != null ? pickupId === dropoffId : null,
    pickupQuery: source === 'discovercars' && typeof data.PickupLocationName === 'string' ? data.PickupLocationName : null,
    dropoffQuery: source === 'discovercars' && typeof data.DropOffLocationName === 'string' ? data.DropOffLocationName : null,
    pickupAt: datetime(source === 'discovercars' ? data.PickupDateTime : `${query.get('pickup_date')}T${query.get('pickup_time')}`),
    dropoffAt: datetime(source === 'discovercars' ? data.DropOffDateTime : `${query.get('dropoff_date')}T${query.get('dropoff_time')}`),
    driver: { age: driverAge === undefined || driverAge === null ? null : Number(driverAge), residenceCountry: typeof residence === 'string' ? residence.toUpperCase() : null },
    currency: query.get('currency'), sources: [source], warnings: [],
  });
  return { kind, url: imported.url, car };
}

export type TravelImportDraft = ReturnType<typeof importTravelDraft>;
