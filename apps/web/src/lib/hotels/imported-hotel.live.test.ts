import { describe, expect, it } from 'vitest';
import { searchHotelSource } from './providers';
import { DEFAULT_HOTEL_FILTERS, type HotelSearch, type HotelSource } from './types';
import fixtures from './provider-fixtures.json';

describe.skipIf(process.env.TRAVEL_LIVE_TESTS !== '1')('selected properties on live hotel providers', () => {
  it.each([['booking', fixtures.booking], ['google_hotels', fixtures.google]] as const)('loads verified rates for the imported %s property', async (source: HotelSource, fixture) => {
    const search: HotelSearch = { sourceUrl: fixture.url, destination: fixture.propertyName, checkIn: '2026-10-20', checkOut: '2026-10-23', dateMode: 'fixed', flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD', sources: [source], filters: DEFAULT_HOTEL_FILTERS };
    const offers = await searchHotelSource(search, search, source);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every(offer => offer.source === source && offer.taxesIncluded && offer.occupancyVerified && offer.totalPrice > 0)).toBe(true);
  }, 90000);
});
