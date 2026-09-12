import { describe, expect, it } from 'vitest';
import { importTravelDraft } from './import-draft';
import { travelImportUrl } from './import-url';
import { readFlightLink, assertFlightLinkSearch, flightLinkQuery } from '../scraper/flight-link';
import { FLIGHT_IMPORT_URL, CAR_IMPORT_URL } from '@/test/import-fixtures';
import fixtures from '../hotels/provider-fixtures.json';

describe('selected travel link import', () => {
  it('recovers both flights and overnight connections without losing the selected return', () => {
    const draft = importTravelDraft(FLIGHT_IMPORT_URL, 'flights');
    expect(draft.flight).toMatchObject({ origin: 'ORD', destination: 'DUS', dateFrom: '2026-10-04', dateTo: '2026-10-19', tripType: 'round_trip', cabinClass: 'economy', flexibility: 0, currency: 'EUR' });
    expect(readFlightLink(FLIGHT_IMPORT_URL).legs).toEqual([
      [{ origin: 'ORD', destination: 'CPH', date: '2026-10-04', airline: 'SK', number: '944' }, { origin: 'CPH', destination: 'DUS', date: '2026-10-05', airline: 'SK', number: '629' }],
      [{ origin: 'DUS', destination: 'CPH', date: '2026-10-19', airline: 'SK', number: '1630' }, { origin: 'CPH', destination: 'ORD', date: '2026-10-19', airline: 'SK', number: '943' }],
    ]);
  });
  it.each([{ dateTo: '2026-10-20' }, { flexibility: 1 }, { cabinClass: 'business' }, { origin: 'MDW' }, { tripType: 'one_way' }])('rejects changing imported flight scope: %j', change => {
    expect(() => assertFlightLinkSearch(FLIGHT_IMPORT_URL, { ...flightLinkQuery(FLIGHT_IMPORT_URL), ...change })).toThrow(/original/);
  });
  it.each(['%', 'AAAA', 'CBwQAhpl', 'A'.repeat(12001)])('rejects malformed or oversized encoded itineraries', tfs => {
    expect(() => readFlightLink(`https://www.google.com/travel/flights/booking?tfs=${tfs}`)).toThrow();
  });
  it.each(['http://www.booking.com/hotel/gb/a.html', 'https://www.booking.com.evil.test/hotel/gb/a.html', 'https://www.booking.com@127.0.0.1/hotel/gb/a.html', 'https://www.booking.com:444/hotel/gb/a.html', 'https://www.booking.com/searchresults.html', 'https://www.booking.com/confirmation', 'file:///tmp/test'])('rejects non-public or unsupported hotel link %s', url => {
    expect(() => travelImportUrl(url, 'hotels')).toThrow();
  });
  it('imports property dates and exact single-room child ages', () => {
    const draft = importTravelDraft('https://booking.com/hotel/gb/strandpalace.html?checkin=2026-10-20&checkout=2026-10-23&group_adults=2&no_rooms=1&group_children=1&age=7&selected_currency=GBP', 'hotels');
    expect(draft.hotel).toMatchObject({ sources: ['booking'], checkIn: '2026-10-20', checkOut: '2026-10-23', currency: 'GBP', rooms: [{ adults: 2, children: [7] }] });
    expect(draft.url).toContain('https://www.booking.com/hotel/gb/strandpalace.html');
  });
  it('preserves the Google property identity and selected dates', () => {
    const draft = importTravelDraft(fixtures.google.url, 'hotels');
    expect(new URL(draft.url).pathname).toBe(new URL(fixtures.google.url).pathname);
    expect(draft.hotel).toMatchObject({ sources: ['google_hotels'], checkIn: '2026-10-20', checkOut: '2026-10-23' });
  });
  it('leaves missing rental licence tenure and catalog locations for the user to supply', () => {
    const draft = importTravelDraft(CAR_IMPORT_URL, 'cars');
    expect(draft.car).toMatchObject({ pickupAt: { date: '2026-10-15', time: '12:00' }, dropoffAt: { date: '2026-10-18', time: '12:00' }, driver: { age: 35, licenceYears: null, residenceCountry: 'GB' }, pickupQuery: null, dropoffQuery: null, sources: ['autoeurope'], currency: 'USD' });
  });
  it('decodes DiscoverCars dates without treating provider IDs as catalog locations', () => {
    const sq = Buffer.from(JSON.stringify({ PickupLocationId: 1712, DropOffLocationId: 1712, PickupDateTime: '2026-10-15T12:00:00', DropOffDateTime: '2026-10-18T12:00:00', DriverAge: 35, ResidenceCountry: 'GB' })).toString('base64');
    const draft = importTravelDraft(`https://www.discovercars.com/offer/12345678-abcd-abcd-abcd-123456789abc-ab12?sq=${encodeURIComponent(sq)}`, 'cars');
    expect(draft.car).toMatchObject({ pickupAt: { date: '2026-10-15', time: '12:00' }, pickupQuery: null, driver: { age: 35, licenceYears: null, residenceCountry: 'GB' }, sources: ['discovercars'] });
  });
});
