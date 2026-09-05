import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { navigateHotelPage } from '../apps/web/src/lib/hotels/navigation';
import { captureBookingRates } from '../apps/web/src/lib/hotels/booking-capture';
import { extractBookingOffers } from '../apps/web/src/lib/hotels/booking-extraction';
import fixtures from '../apps/web/src/lib/hotels/provider-fixtures.json';
import { DEFAULT_HOTEL_FILTERS, type HotelSearch } from '../apps/web/src/lib/hotels/types';

// Real Chromium navigation with fixtures only at the HTTP boundary.
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.HOTEL_BROWSER_EXECUTABLE ? { executablePath: process.env.HOTEL_BROWSER_EXECUTABLE } : {}) });
  const hotelUrl = 'https://www.google.com/travel/hotels';
  const cases = [
    { name: 'rejects consent and returns to hotel results', target: hotelUrl, expected: 'Hotel results' },
    { name: 'blocks unrelated consent destinations', target: 'https://unrelated.example/travel/hotels' },
    { name: 'blocks insecure consent destinations', target: 'http://www.google.com/travel/hotels' },
    { name: 'blocks internal consent destinations', target: 'https://127.0.0.1/private' },
    { name: 'rejects unresolved consent', target: '' },
    { name: 'rejects a delayed final error after an allowed intermediate redirect', target: `${hotelUrl}/intermediate`, error: /HTTP 503/ },
  ];
  try {
    for (const scenario of cases) {
      const context = await browser.newContext();
      let consentVisited = false;
      const visited: string[] = [];
      const server = createServer((request, response) => {
        const url = new URL(new URL(request.url!, 'http://localhost').searchParams.get('destination')!);
        visited.push(url.href);
        if (url.pathname.endsWith('/intermediate')) {
          response.writeHead(302, { location: `${hotelUrl}/unavailable` });
          return response.end();
        }
        if (url.pathname.endsWith('/unavailable')) {
          setTimeout(() => { response.writeHead(503, { 'content-type': 'text/html' }); response.end('<main>Temporarily unavailable</main>'); }, 1000);
          return;
        }
        if (url.hostname === 'consent.google.com') {
          consentVisited = true;
          if (url.pathname === '/save') {
            response.writeHead(302, { location: scenario.target });
            return response.end();
          }
          response.setHeader('content-type', 'text/html');
          return response.end(scenario.target ? '<form action="https://consent.google.com/save"><button>Reject all</button></form>' : '<main>Consent unavailable</main>');
        }
        if (!consentVisited) {
          response.writeHead(302, { location: 'https://consent.google.com/m' });
          return response.end();
        }
        response.setHeader('content-type', 'text/html');
        response.end('<main>Hotel results</main>');
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const page = await context.newPage();
      // Replace only the network transport. Chromium, routing, redirect status
      // handling, consent interaction and final-page checks remain real.
      const register = page.route.bind(page);
      page.route = (pattern, handler, options) => register(pattern, route => handler(new Proxy(route, {
        get(target, property) {
          if (property === 'fetch') return (fetchOptions: Parameters<typeof route.fetch>[0]) => target.fetch({ ...fetchOptions, url: `http://127.0.0.1:${address.port}/?destination=${encodeURIComponent(target.request().url())}` });
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }), route.request()), options);
      try {
        if (scenario.expected) {
          await navigateHotelPage(page, hotelUrl, 'google_hotels');
          assert.equal(new URL(page.url()).hostname, 'www.google.com');
          assert.equal(await page.locator('main').innerText(), scenario.expected);
        } else {
          await assert.rejects(navigateHotelPage(page, hotelUrl, 'google_hotels'), scenario.error ?? /consent/);
          if (scenario.target && !scenario.error) assert.equal(visited.includes(scenario.target), false, 'Unsafe redirect must never reach the network');
        }
        console.log(`PASS ${scenario.name}`);
      } finally { await context.close(); server.close(); }
    }
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Unexpected destination</main>' }));
    const page = await context.newPage();
    await assert.rejects(navigateHotelPage(page, 'https://consent.google.com/m', 'booking'), /ERR_BLOCKED_BY_CLIENT/);
    console.log('PASS Booking cannot navigate to Google consent');
    await context.close();
    const booking = await browser.newPage();
    const table = (id: string, header: string, nights: string, price: number) => `<table><thead><tr><th>${header}</th></tr></thead><tbody><tr><td><span data-testid="room-name">Room ${id}</span><p>Sleeps: 2 adults</p><p>US$${price}</p><p>${nights}</p><p>Includes taxes and charges</p><p>Breakfast included</p><p>Free cancellation</p><select name="nr_rooms_${id}"><option value="1">1</option></select></td></tr></tbody></table>`;
    await booking.setContent(table('whole-stay', 'Price for 3 nights', '', 529) + table('neutral', "Today's price", '3 nights', 611) + table('wrong', 'Price for 2 nights', '', 100));
    const search: HotelSearch = { destination: 'London', dateMode: 'fixed', checkIn: '2026-10-20', checkOut: '2026-10-23', flexibility: 0, minNights: 3, maxNights: 3, rooms: [{ adults: 2, children: [] }], currency: 'USD', sources: ['booking'], filters: DEFAULT_HOTEL_FILTERS };
    const capture = { ...fixtures.booking, controls: fixtures.booking.controls.replace('room1=A,A,6\nroom2=A', 'room1=A,A'), rates: await captureBookingRates(booking) };
    assert.deepEqual(extractBookingOffers(capture, search, search).map(offer => offer.totalPrice), [529, 611]);
    console.log('PASS Booking keeps table-local whole-stay and neutral-header rates, rejects wrong duration');
    await booking.close();
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
