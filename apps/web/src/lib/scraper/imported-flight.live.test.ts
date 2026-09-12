import { describe, expect, it } from 'vitest';
import { captureImportedFlight } from './imported-flight';
import { flightLinkQuery } from './flight-link';
import { FLIGHT_IMPORT_URL } from '@/test/import-fixtures';

describe.skipIf(process.env.TRAVEL_LIVE_TESTS !== '1')('selected itinerary on live Google Flights', () => {
  it('opens every selected segment and verifies the booking currency', async () => {
    const original = new URL(FLIGHT_IMPORT_URL);
    original.searchParams.delete('curr');
    original.searchParams.set('tfu', 'CnRDalJJUTAxM1gwWlZUVXc0UTNkQlNWSkVPR2RDUnkwdExTMHRMUzB0TFc5NWRtb3hNVUZCUVVGQlIzRnJkM1IzUkdNMGRVRkJFZ3hUU3pFMk16QjhVMHM1TkRNYUN3aVN0Z1FRQWhvRFJWVlNPQnh3L1pBRhICCAAiAA');
    original.searchParams.set('gl', 'DE');
    original.searchParams.set('client', 'safari');
    const query = flightLinkQuery(original.href);
    const result = await captureImportedFlight({ ...query, sourceUrl: original.href, dateFrom: new Date(query.dateFrom), dateTo: new Date(query.dateTo) });
    expect(result.currency).toBe('EUR');
    expect(result.link.legs.flat().map(segment => `${segment.airline} ${segment.number}`)).toEqual(['SK 944', 'SK 629', 'SK 1630', 'SK 943']);
    expect(result.html).toMatch(/Booking options/);
  }, 90000);
});
