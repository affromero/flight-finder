import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routeProviderTransport } from '@/test/provider-transport';
import { navigateFlightDetail, navigateGoogleFlights } from '../navigate';

const transport = vi.hoisted(() => ({ origin: '' }));
vi.mock('playwright', async original => {
  const actual = await original<typeof import('playwright')>();
  return { ...actual, chromium: { ...actual.chromium, launch: async (options: Parameters<typeof actual.chromium.launch>[0]) => routeProviderTransport(await actual.chromium.launch(options), transport.origin) } };
});

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('canonical Google flight navigation', () => {
  let server: Server;
  let mode: 'delayed' | 'empty' | 'wrong-route' | 'detail' | 'localized' = 'delayed';
  let localizedPrices: string[] = [];
  const params = { origin: 'JFK', destination: 'LAX', dateFrom: new Date('2026-11-06'), dateTo: new Date('2026-11-06'), tripType: 'one_way', currency: 'EUR' };
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (!request.url?.startsWith('/www.google.com/travel/flights?')) {
        response.writeHead(404); response.end(); return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const prices = mode === 'localized' ? localizedPrices : ['EUR 120', 'EUR 150', 'EUR 180'];
      const priced = `<h1>Flights from ${mode === 'wrong-route' ? 'LAX to JFK' : 'JFK to LAX'}</h1>${prices.map(price => `<p>${price}</p>`).join('')}`;
      if (mode === 'empty') { response.end('<div data-gs>Loading results</div><h1>Flights from JFK to LAX</h1>'); return; }
      if (mode === 'wrong-route' || mode === 'localized') { response.end(`<div data-gs>${priced}</div>`); return; }
      if (mode === 'detail') {
        response.end('<div role="dialog" aria-label="Cookie consent"><button onclick="this.parentElement.remove();document.getElementById(\'flights\').hidden=false">Continue</button></div><ul id="flights" hidden><li class="pIav2d" onclick="document.getElementById(\'booking\').hidden=false">Select flight</li></ul><pre id="booking" hidden>Book with Fixture AirAirline\n€245</pre>'); return;
      }
      response.end(`<button hidden>Tout accepter</button><div role="dialog" aria-label="Cookie consent"><button onclick="this.parentElement.remove();setTimeout(()=>document.getElementById('results').innerHTML=${JSON.stringify(priced).replace(/"/g, '&quot;')},7000)">Tout accepter</button></div><div data-gs id="results">Loading results</div>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing navigation fixture');
    transport.origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

  it('dismisses localized consent and waits for priced rows after the empty shell', async () => {
    mode = 'delayed';
    const result = await navigateGoogleFlights(params);
    expect(result).toMatchObject({ resultsFound: true, source: 'google_flights' });
    expect(result.html).toContain('EUR 120');
    expect(result.html).not.toContain('Loading results');
    expect(result.html).not.toContain('Tout accepter');
  }, 30000);
  it.each([
    { currency: null, symbol: '¥' },
    { currency: null, symbol: '￥' },
    { currency: null, symbol: '₹' },
    { currency: null, symbol: '₩' },
    { currency: 'JPY', symbol: '¥' },
    { currency: 'ZWG', symbol: 'ZWG ' },
  ])('loads $symbol fares when currency is $currency', async ({ currency, symbol }) => {
    mode = 'localized';
    localizedPrices = ['7,057', '7,318', '8,283'].map(amount => `${symbol}${amount}`);
    const result = await navigateGoogleFlights({ ...params, currency });
    expect(result).toMatchObject({ resultsFound: true, source: 'google_flights' });
    expect(result.html).toContain(`${symbol}7,057`);
    expect(new URL(result.url).searchParams.get('curr')).toBe(currency);
  }, 120000);
  it('rejects an empty results container across all URL candidates', async () => {
    mode = 'empty';
    const result = await navigateGoogleFlights(params);
    expect(result.resultsFound).toBe(false);
    expect(result.html).toContain('Loading results');
  }, 150000);
  it('rejects priced results for the reverse route across all URL candidates', async () => {
    mode = 'wrong-route';
    const result = await navigateGoogleFlights(params);
    expect(result.resultsFound).toBe(false);
    expect(result.html).toContain('LAX to JFK');
  }, 60000);
  it('uses scoped consent before opening the requested flight detail', async () => {
    mode = 'detail';
    expect(await navigateFlightDetail(params, 0)).toMatchObject({ airlineDirectPrice: 245, airlineDirectCurrency: 'EUR', allBookingOptions: [{ provider: 'Fixture Air', isAirline: true, price: 245, currency: 'EUR' }] });
  }, 25000);
});
