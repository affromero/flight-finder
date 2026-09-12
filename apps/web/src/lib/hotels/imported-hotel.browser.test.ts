import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeProviderTransport } from '@/test/provider-transport';
import { searchHotelSource } from './providers';
import { DEFAULT_HOTEL_FILTERS, type HotelSearch } from './types';

const boundary = vi.hoisted(() => ({ origin: '' }));
vi.mock('playwright', async original => {
  const actual = await original<typeof import('playwright')>();
  return { ...actual, chromium: { ...actual.chromium, launch: async (options: Parameters<typeof actual.chromium.launch>[0]) => routeProviderTransport(await actual.chromium.launch(options), boundary.origin) } };
});

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('imported hotel property browser flow', () => {
  let server: Server, changed = false;
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      if (url.pathname.endsWith('/selected.html')) {
        response.writeHead(302, { location: `https://www.booking.com/hotel/gb/${changed ? 'another' : 'selected'}.en-gb.html${url.search}` }); response.end(); return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<h1>Selected Hotel</h1><input type="hidden" name="checkin" value="2026-10-20"><input type="hidden" name="checkout" value="2026-10-23"><input type="hidden" name="interval" value="3"><input type="hidden" name="room1" value="A,A"><table><thead><tr><th>Price for 3 nights</th></tr></thead><tbody><tr><td><div data-testid="room-name">Double room</div><div>Sleeps: 2 adults</div><div>Current price £450</div><div>Includes taxes and fees</div><div>Free cancellation</div><div>Breakfast included</div><select name="nr_rooms_double_rate"><option value="0">0</option><option value="2">2</option></select></td></tr></tbody></table>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider fixture');
    boundary.origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => { changed = false; });
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
  const search: HotelSearch = { sourceUrl: 'https://www.booking.com/hotel/gb/selected.html', destination: 'Selected Hotel', checkIn: '2026-10-20', checkOut: '2026-10-23', dateMode: 'fixed', flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'GBP', sources: ['booking'], filters: DEFAULT_HOTEL_FILTERS };
  it('accepts a language redirect and returns verified rates for the selected property', async () => {
    const offers = await searchHotelSource(search, search, 'booking');
    expect(offers).toEqual([expect.objectContaining({ propertyId: 'booking:/hotel/gb/selected.html', totalPrice: 450, currency: 'GBP', roomName: 'Double room', taxesIncluded: true, occupancyVerified: true })]);
  }, 20000);
  it('rejects a redirect to another hotel without returning its rates', async () => {
    changed = true;
    await expect(searchHotelSource(search, search, 'booking')).rejects.toThrow(/changed.*property/);
  }, 20000);
});
