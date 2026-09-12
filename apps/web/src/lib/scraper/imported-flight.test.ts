import { describe, expect, it } from 'vitest';
import { readFlightLink } from './flight-link';
import { verifyImportedFlightPage } from './imported-flight';
import { FLIGHT_IMPORT_URL, FLIGHT_IMPORT_TEXT } from '@/test/import-fixtures';

describe('selected flight page verification', () => {
  it('accepts the complete displayed itinerary, including an overnight connection', () => {
    expect(() => verifyImportedFlightPage(readFlightLink(FLIGHT_IMPORT_URL), FLIGHT_IMPORT_URL, FLIGHT_IMPORT_TEXT)).not.toThrow();
  });
  it.each([
    FLIGHT_IMPORT_TEXT.replace('SK 943', 'SK 945'),
    FLIGHT_IMPORT_TEXT.replace('Economy', 'Business'),
    FLIGHT_IMPORT_TEXT.replace('Mon, Oct 19', 'Tue, Oct 20'),
    FLIGHT_IMPORT_TEXT.replaceAll('+1', ''),
    FLIGHT_IMPORT_TEXT.replace('8:50 PM+1Copenhagen', '8:50 PM+2Copenhagen'),
    FLIGHT_IMPORT_TEXT.replace('10:10 AMDuesseldorf', '10:10 AM+1Duesseldorf'),
    FLIGHT_IMPORT_TEXT.replace('4:10 PMChicago O\'Hare International Airport (ORD)', '4:10 PMNew York (JFK)'),
    'No booking options',
  ])('rejects incomplete or changed itineraries before extracting a price', text => {
    expect(() => verifyImportedFlightPage(readFlightLink(FLIGHT_IMPORT_URL), FLIGHT_IMPORT_URL, text)).toThrow();
  });
  it('rejects a redirect to an unselected results page', () => {
    expect(() => verifyImportedFlightPage(readFlightLink(FLIGHT_IMPORT_URL), 'https://www.google.com/travel/flights', FLIGHT_IMPORT_TEXT)).toThrow();
  });
});
