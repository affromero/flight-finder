import { describe, it, expect } from 'vitest';
import { validateHotelSearch, expandHotelStays, matchesHotelFilters, matchHotelSelection, evaluateHotelAlerts, validateHotelOptions } from './domain';
import type { HotelOffer, HotelSelection } from './types';

const NOW = new Date('2026-09-05');
const input = { destination: 'London', checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: [{ adults: 2, children: [] }], currency: 'USD' };
const search = () => validateHotelSearch(input, NOW);
function offer(changes: Partial<HotelOffer> = {}): HotelOffer {
  return { id: 'offer', source: 'booking', propertyId: 'park', hotelName: 'Park Hotel', address: 'London', imageUrl: null, propertyUrl: 'https://www.booking.com/hotel/gb/park.html', bookingUrl: 'https://www.booking.com/hotel/gb/park.html', seller: 'Booking.com', roomName: 'Deluxe double room', rateName: 'refundable-breakfast', totalPrice: 700, currency: 'USD', taxesIncluded: true, occupancyVerified: true, checkIn: input.checkIn, checkOut: input.checkOut, rooms: input.rooms, refundable: true, breakfast: true, stars: 4, rating: 8.6, amenities: { pool: true }, match: 'exact', ...changes };
}
const options = () => validateHotelOptions({ targetPrice: 700 });
describe('hotel search criteria', () => {
  it('preserves separate child allocations in multiple rooms', () => {
    const rooms = [{ adults: 2, children: [3, 12] }, { adults: 1, children: [0] }];
    expect(validateHotelSearch({ ...input, rooms }, NOW).rooms).toEqual(rooms);
  });
  it.each(['2026-02-30', 'yesterday', '2026-13-01', '2026-9-10'])('rejects invalid calendar date %s', checkIn => {
    expect(() => validateHotelSearch({ ...input, checkIn }, NOW)).toThrow(/date/i);
  });
  it.each([[], [{ adults: 0, children: [] }], [{ adults: 2, children: [-1] }], [{ adults: 2, children: [18] }]].map(rooms => ({ rooms })))('rejects invalid guest allocations $rooms', ({ rooms }) => {
    expect(() => validateHotelSearch({ ...input, rooms }, NOW)).toThrow();
  });
  it('rejects a past stay without launching a search', () => {
    expect(() => validateHotelSearch({ ...input, checkIn: '2026-08-01' }, NOW)).toThrow(/future/);
  });
  it('rejects unknown sources and currencies', () => {
    expect(() => validateHotelSearch({ ...input, sources: ['expedia'] }, NOW)).toThrow(/sources/);
    expect(() => validateHotelSearch({ ...input, currency: 'ZZZ' }, NOW)).toThrow(/currency/);
  });
  it('expands nearby arrival and departure dates while preserving valid stays', () => {
    const s = validateHotelSearch({ ...input, dateMode: 'nearby', flexibility: 1 }, NOW);
    expect(expandHotelStays(s, NOW)).toContainEqual({ checkIn: '2026-10-14', checkOut: '2026-10-19' });
    expect(expandHotelStays(s, NOW)).toHaveLength(9);
  });
  it('enumerates all allowed lengths within a window', () => {
    const s = validateHotelSearch({ ...input, dateMode: 'window', minNights: 2, maxNights: 3 }, NOW);
    expect(expandHotelStays(s, NOW)).toEqual([{ checkIn: '2026-10-15', checkOut: '2026-10-17' }, { checkIn: '2026-10-15', checkOut: '2026-10-18' }, { checkIn: '2026-10-16', checkOut: '2026-10-18' }]);
  });
  it('rejects excessive work instead of silently truncating dates', () => {
    expect(() => validateHotelSearch({ ...input, dateMode: 'nearby', flexibility: 3 }, NOW)).toThrow(/combinations/);
  });
  it('rejects a window with no valid stay length', () => {
    expect(() => validateHotelSearch({ ...input, dateMode: 'window', minNights: 5, maxNights: 7 }, NOW)).toThrow(/No valid/);
  });
});
describe('qualifying hotel prices', () => {
  it.each([{ taxesIncluded: false }, { occupancyVerified: false }, { currency: 'GBP' }, { totalPrice: NaN }, { totalPrice: 0 }, { rooms: [{ adults: 1, children: [] }] }])('rejects incomparable offer %j', changes => {
    expect(matchesHotelFilters(offer(changes), search())).toBe(false);
  });
  it('requires affirmative evidence for every selected amenity', () => {
    const s = search(); s.filters.amenities = ['pool', 'parking'];
    expect(matchesHotelFilters(offer(), s)).toBe(false);
    expect(matchesHotelFilters(offer({ amenities: { pool: true, parking: true } }), s)).toBe(true);
  });
  it('does not interpret unknown cancellation and meal conditions as qualifying', () => {
    const s = search(); s.filters.refundable = true; s.filters.breakfast = true;
    expect(matchesHotelFilters(offer({ refundable: null }), s)).toBe(false);
    expect(matchesHotelFilters(offer({ breakfast: null }), s)).toBe(false);
    expect(matchesHotelFilters(offer(), s)).toBe(true);
  });
  it('retains above-budget tracker observations but filters search results', () => {
    const s = search(); s.filters.maxTotal = 500;
    expect(matchesHotelFilters(offer(), s)).toBe(false);
    expect(matchesHotelFilters(offer(), s, true)).toBe(true);
  });
  it('normalizes excluded seller names', () => {
    const s = search(); s.filters.excludedSellers = ['BOOKING.COM'];
    expect(matchesHotelFilters(offer(), s)).toBe(false);
  });
  it('checks hotel class and normalized guest rating', () => {
    const s = search(); s.filters.minStars = 4; s.filters.minRating = 8;
    expect(matchesHotelFilters(offer({ stars: null }), s)).toBe(false);
    expect(matchesHotelFilters(offer({ rating: 7.9 }), s)).toBe(false);
    expect(matchesHotelFilters(offer(), s)).toBe(true);
  });
});
describe('room and rate matching', () => {
  const selection: HotelSelection = { ...offer(), providerRateId: 'provider-rate-1' };
  it('keeps different properties and sources out of a tracker', () => {
    expect(matchHotelSelection(offer({ propertyId: 'another' }), selection, 'best')).toBeNull();
    expect(matchHotelSelection(offer({ source: 'google_hotels' }), selection, 'room')).toBeNull();
  });
  it('recognizes stable room, rate and conditions', () => {
    expect(matchHotelSelection(offer({ providerRateId: 'provider-rate-1' }), selection, 'room')).toBe('exact');
  });
  it('marks descriptive room similarity as approximate', () => {
    expect(matchHotelSelection(offer({ roomName: 'Deluxe double room city view', rateName: null }), selection, 'room')).toBe('approximate');
  });
  it('does not substitute nonrefundable or different-seller rooms', () => {
    expect(matchHotelSelection(offer({ refundable: false }), selection, 'room')).toBeNull();
    expect(matchHotelSelection(offer({ seller: 'Another seller' }), selection, 'room')).toBeNull();
  });
});
describe('hotel alert transitions', () => {
  it('alerts immediately below target without inventing a historical low', () => {
    const result = evaluateHotelAlerts({ targetArmed: true, historicalLow: null }, options(), 690, true);
    expect(result).toMatchObject({ target: true, low: false, state: { targetArmed: false, historicalLow: 690 } });
  });
  it('does not repeat target alerts while prices remain below target', () => {
    expect(evaluateHotelAlerts({ targetArmed: false, historicalLow: 650 }, options(), 680, true)).toMatchObject({ target: false, low: false });
  });
  it('rearms only on a complete above-target observation', () => {
    const state = { targetArmed: false, historicalLow: 650 };
    expect(evaluateHotelAlerts(state, options(), 800, false).state.targetArmed).toBe(false);
    const rearmed = evaluateHotelAlerts(state, options(), 800, true);
    expect(evaluateHotelAlerts(rearmed.state, options(), 700, true).target).toBe(true);
  });
  it('preserves alert state after failed or missing observations', () => {
    const state = { targetArmed: false, historicalLow: 650 };
    expect(evaluateHotelAlerts(state, options(), null, false)).toEqual({ target: false, low: false, state });
  });
  it('emits historical lows independently of target crossing', () => {
    expect(evaluateHotelAlerts({ targetArmed: false, historicalLow: 650 }, options(), 620, true)).toMatchObject({ target: false, low: true });
  });
  it('defaults approximate alerts off and validates interval and price inputs', () => {
    expect(options().allowApproximateAlerts).toBe(false);
    expect(() => validateHotelOptions({ targetPrice: Infinity })).toThrow(/Price/);
    expect(() => validateHotelOptions({ scrapeInterval: 0 })).toThrow(/interval/);
  });
});
