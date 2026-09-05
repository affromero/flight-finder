import { describe, expect, it } from 'vitest';
import { bookingSearchUrl } from './booking';
import { googleSearchUrl } from './google';
import { extractBookingOffers } from './booking-extraction';
import { extractGoogleOffers } from './google-extraction';
import { googleSelectedDates } from './google';
import { hotelAmenities } from './property-metadata';
import fixtures from './provider-fixtures.json';
import { DEFAULT_HOTEL_FILTERS, type HotelSearch, type HotelSelection } from './types';

const search: HotelSearch = { destination: 'London', dateMode: 'fixed', checkIn: '2026-10-20', checkOut: '2026-10-23', flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD', sources: ['booking'], filters: DEFAULT_HOTEL_FILTERS };
const stay = { checkIn: search.checkIn, checkOut: search.checkOut };
const propertyUrl = 'https://www.booking.com/hotel/gb/strandpalace.html';
const selection: HotelSelection = { propertyId: 'booking:/hotel/gb/strandpalace.html', source: 'booking', hotelName: 'Strand Palace', propertyUrl, roomName: null, rateName: null, seller: 'Booking.com', refundable: null, breakfast: null };
describe('hotel provider requests', () => {
  it('preserves stay dates, each child age, room count and total adults', () => {
    const url = new URL(bookingSearchUrl({ ...search, rooms: [{ adults: 2, children: [4] }, { adults: 1, children: [12] }] }, stay));
    expect(url.searchParams.get('checkin')).toBe(stay.checkIn);
    expect(url.searchParams.get('checkout')).toBe(stay.checkOut);
    expect(url.searchParams.get('no_rooms')).toBe('2');
    expect(url.searchParams.get('group_adults')).toBe('3');
    expect(url.searchParams.getAll('age')).toEqual(['4', '12']);
    expect(url.searchParams.get('room1')).toBe('A,A,4');
    expect(url.searchParams.get('room2')).toBe('A,12');
  });
  it('removes stale session and previous stay parameters from saved properties', () => {
    const url = new URL(bookingSearchUrl(search, stay, { ...selection, propertyUrl: `${propertyUrl}?sid=secret&checkin=2020-01-01` }));
    expect(url.searchParams.has('sid')).toBe(false);
    expect(url.searchParams.get('checkin')).toBe(stay.checkIn);
  });
  it.each(['http://www.booking.com/hotel/gb/a.html', 'https://www.booking.com.evil.test/hotel/gb/a.html', 'https://127.0.0.1/hotel/gb/a.html', 'https://www.booking.com/admin'])('rejects unsafe saved property navigation: %s', propertyUrl => {
    expect(() => bookingSearchUrl(search, stay, { ...selection, propertyUrl })).toThrow(/Invalid/);
  });
  it('uses natural date text that Google recognizes rather than ambiguous numeric tokens', () => {
    const url = new URL(googleSearchUrl(search, stay));
    expect(url.searchParams.get('q')).toContain('October 20, 2026');
    expect(url.searchParams.get('q')).toContain('October 23, 2026');
    expect(url.searchParams.get('curr')).toBe('USD');
  });
  it('updates a saved hotel to new date years and duration without changing its entity', () => {
    const newStay = { checkIn: '2027-11-02', checkOut: '2027-11-07' };
    const url = googleSearchUrl(search, newStay, { ...selection, source: 'google_hotels', propertyUrl: fixtures.google.url });
    expect(googleSelectedDates(url)).toEqual([newStay.checkIn, newStay.checkOut]);
    expect(new URL(url).pathname).toBe(new URL(fixtures.google.url).pathname);
  });
});


const family = { ...search, rooms: [{ adults: 2, children: [6] }, { adults: 1, children: [] }] };

describe('captured Booking property rates', () => {
  const headerPriced = {
    ...fixtures.booking,
    controls: fixtures.booking.controls.replace('room1=A,A,6\nroom2=A', 'room1=A,A'),
    rates: [
      { id: '24138030_442483970_2_2_0', roomName: 'Double Room with Private Bathroom', available: 9, priceBasis: 'Price for 3 nights', text: 'Sleeps: 2 adults\nUS$588\nUS$529\nOriginal price US$588 Current price US$529\nIncludes taxes and charges\nBreakfast US$11 (optional)\nFree cancellation before 6 October 2026' },
      { id: '24138030_442483970_2_1_0', roomName: 'Double Room with Private Bathroom', available: 9, priceBasis: 'Price for 3 nights', text: 'Sleeps: 2 adults\nUS$611\nIncludes taxes and charges\nBreakfast included\nFree cancellation before 6 October 2026' },
    ],
  };
  it('uses the corresponding whole-stay table header for rates without repeated stay lengths', () => {
    const offers = extractBookingOffers(headerPriced, search, stay);
    expect(offers.map(offer => ({ price: offer.totalPrice, breakfast: offer.breakfast, taxes: offer.taxesIncluded }))).toEqual([
      { price: 529, breakfast: false, taxes: true }, { price: 611, breakfast: true, taxes: true },
    ]);
  });
  it.each([undefined, '', 'Price', 'Price for 2 nights', 'Price per night', 'Price for 3 nights, per night'])('rejects unverified or conflicting table price basis: %s', priceBasis => {
    expect(() => extractBookingOffers({ ...headerPriced, rates: headerPriced.rates.map(rate => ({ ...rate, priceBasis })) }, search, stay)).toThrow(/tax-inclusive/);
  });
  it('removes the provider SEO suffix without changing the property name', () => {
    const offers = extractBookingOffers({ ...fixtures.booking, propertyName: 'Strand Palace (Hotel) (UK) deals' }, family, stay);
    expect(offers.every(offer => offer.hotelName === 'Strand Palace')).toBe(true);
  });
  it('prices each family room with mandatory VAT and stable rate identities', () => {
    const offers = extractBookingOffers(fixtures.booking, family, stay);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every(offer => offer.taxesIncluded && offer.occupancyVerified && offer.totalPrice > 0)).toBe(true);
    expect(offers[0]).toMatchObject({ hotelName: 'Strand Palace', rooms: family.rooms, seller: 'Booking.com' });
    expect(offers.some(offer => offer.providerRateId?.includes('+') && offer.match === 'exact')).toBe(true);
    expect(offers.find(offer => offer.providerRateId === '23080238_91912860_2_42_0+23080234_91912860_0_42_0')?.totalPrice).toBe(2600.4);
  });
  it('rejects redistribution of a child into another room', () => {
    const page = { ...fixtures.booking, controls: fixtures.booking.controls.replace('room1=A,A,6\nroom2=A', 'room1=A,A\nroom2=A,6') };
    expect(() => extractBookingOffers(page, family, stay)).toThrow(/allocation/);
  });
  it('rejects the wrong year despite matching month and day', () => {
    expect(() => extractBookingOffers(fixtures.booking, family, { checkIn: '2027-10-20', checkOut: '2027-10-23' })).toThrow(/year/);
  });
  it('does not substitute adult-only rates for a child allocation', () => {
    const page = { ...fixtures.booking, rates: fixtures.booking.rates.filter(rate => !rate.text.includes('Max children')) };
    expect(() => extractBookingOffers(page, family, stay)).toThrow(/every requested room/);
  });
  it('retains the selected stable rate when another rate has become cheaper', () => {
    const selected = extractBookingOffers(fixtures.booking, family, stay).at(-1)!;
    const original = fixtures.booking.rates.find(rate => rate.id === selected.providerRateId?.split('+')[0])!;
    const cheaper = { ...original, id: `${original.id}_cheaper`, text: original.text.replace(/US\$([\d,]+)/g, (match, value: string) => `US$${Math.floor(Number(value.replaceAll(',', '')) / 2)}`) };
    const page = { ...fixtures.booking, rates: [cheaper, ...fixtures.booking.rates] };
    const result = extractBookingOffers(page, family, stay, { ...selection, providerRateId: selected.providerRateId });
    expect(result.some(offer => offer.providerRateId?.includes('_cheaper'))).toBe(true);
    expect(result.find(offer => offer.providerRateId === selected.providerRateId)?.totalPrice).toBe(selected.totalPrice);
  });
  it('rejects the wrong checkout year without accepting matching month/day', () => {
    expect(() => extractBookingOffers(fixtures.booking, family, { ...stay, checkOut: '2027-10-23' })).toThrow(/checkout/);
  });
  it('distinguishes confirmed unavailability from an unloaded table', () => {
    expect(extractBookingOffers({ ...fixtures.booking, rates: [], text: 'No availability for your dates' }, family, stay)).toEqual([]);
    expect(() => extractBookingOffers({ ...fixtures.booking, rates: [] }, family, stay)).toThrow(/table/);
  });
  it('rejects unquantified mandatory charges', () => {
    const page = { ...fixtures.booking, rates: fixtures.booking.rates.map(rate => ({ ...rate, text: rate.text + '\nCity tax payable locally' })) };
    expect(() => extractBookingOffers(page, family, stay)).toThrow(/tax-inclusive/);
  });
  it('does not allocate inventory the provider cannot supply', () => {
    const page = { ...fixtures.booking, rates: fixtures.booking.rates.map(rate => ({ ...rate, available: 0 })) };
    expect(() => extractBookingOffers(page, family, stay)).toThrow(/every requested room/);
  });
});

describe('captured Google visible seller totals', () => {
  it('uses the verified hotel entity label instead of the destination search heading', () => {
    const page = { ...fixtures.google, propertyName: 'London · 15,000 results', links: [...fixtures.google.links, { text: "Open Mimi's Hotel Soho in a new tab.", url: fixtures.google.url }] };
    expect(extractGoogleOffers(page, search, stay).every(offer => offer.hotelName === "Mimi's Hotel Soho")).toBe(true);
  });
  it('reads full selected dates from provider search state', () => {
    expect(googleSelectedDates(fixtures.google.url)).toEqual([stay.checkIn, stay.checkOut]);
    expect(googleSelectedDates('https://www.google.com/travel/hotels?ts=broken')).toEqual([]);
  });
  it('uses stay totals with taxes and keeps generic rates approximate', () => {
    const offers = extractGoogleOffers(fixtures.google, search, stay);
    expect(offers.some(offer => offer.seller === 'Priceline' && offer.totalPrice === 647)).toBe(true);
    expect(offers.every(offer => offer.match === 'approximate' && offer.taxesIncluded)).toBe(true);
    expect(offers.some(offer => offer.refundable === true && offer.totalPrice === 750)).toBe(true);
  });
  it('rejects nightly mode despite plausible prices', () => {
    expect(() => extractGoogleOffers({ ...fixtures.google, totalPriceBasis: 'Nightly excluding taxes' }, search, stay)).toThrow(/stay total/);
  });
  it('rejects extra children not requested', () => {
    expect(() => extractGoogleOffers({ ...fixtures.google, controls: fixtures.google.controls.replaceAll('Remove child00Add child', 'Remove child11Add child') }, search, stay)).toThrow(/guest counts/);
  });
  it('does not count one child age twice for same-aged siblings', () => {
    const page = { ...fixtures.google, controls: fixtures.google.controls.replaceAll('Remove child00Add child', 'Remove child22Add child') + '\nAge=6' };
    expect(() => extractGoogleOffers(page, { ...search, rooms: [{ adults: 2, children: [6, 6] }] }, stay)).toThrow(/child ages/);
  });
  it('requires individual room allocation evidence for multiroom', () => {
    expect(() => extractGoogleOffers(fixtures.google, family, stay)).toThrow(/room allocation/);
  });
  it('rejects the wrong year even when date labels match', () => {
    expect(() => extractGoogleOffers(fixtures.google, search, { checkIn: '2027-10-20', checkOut: '2027-10-23' })).toThrow(/years/);
  });
  it('does not relabel foreign currency amounts', () => {
    expect(() => extractGoogleOffers(fixtures.google, { ...search, currency: 'EUR' }, stay)).toThrow(/currency/);
  });
});

describe('property facilities', () => {
  it('preserves absent amenities and leaves omitted facilities unknown', () => {
    expect(hotelAmenities('Pets are not allowed. No parking available.')).toEqual({ pets: false, parking: false });
  });
  it('recognizes explicit accessibility and pool facilities', () => {
    expect(hotelAmenities('Facilities for disabled guests\nIndoor pool')).toMatchObject({ accessible: true, pool: true });
  });
  it('does not promise facilities that are absent or require confirmation', () => {
    expect(hotelAmenities('No swimming pool. Pets are allowed on request.')).toEqual({ pool: false });
  });
});
