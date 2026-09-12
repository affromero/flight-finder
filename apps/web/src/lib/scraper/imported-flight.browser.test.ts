import { createServer, type Server } from 'node:http';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { routeProviderTransport } from '@/test/provider-transport';
import { FLIGHT_IMPORT_URL, FLIGHT_IMPORT_TEXT } from '@/test/import-fixtures';
import { flightLinkQuery } from './flight-link';
import { captureImportedFlight, scrapeImportedFlight } from './imported-flight';

const boundary = vi.hoisted(() => ({ origin: '', extract: vi.fn() }));
vi.mock('playwright', async original => {
  const actual = await original<typeof import('playwright')>();
  return { ...actual, chromium: { ...actual.chromium, launch: async (options: Parameters<typeof actual.chromium.launch>[0]) => routeProviderTransport(await actual.chromium.launch(options), boundary.origin) } };
});
vi.mock('./ai-registry', async original => {
  const actual = await original<typeof import('./ai-registry')>();
  return { ...actual, EXTRACTION_PROVIDERS: { ...actual.EXTRACTION_PROVIDERS, openai: { ...actual.EXTRACTION_PROVIDERS.openai, extract: boundary.extract } } };
});
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) } } }));

describe.skipIf(process.env.TRAVEL_BROWSER_TESTS !== '1')('imported flight browser and price extraction', () => {
  let server: Server, changed = false, redirect = false;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (redirect) { response.writeHead(302, { location: 'https://127.0.0.1/private' }); response.end(); return; }
      const text = changed ? FLIGHT_IMPORT_TEXT.replace('SK 943', 'SK 945') : FLIGHT_IMPORT_TEXT;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<button aria-label="Currency EUR">EUR</button><button aria-label="Flight details. Departing flight" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('details').hidden=false">Details</button><button aria-label="Flight details. Return flight" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Details</button><p>Book with a provider</p><pre id="details" hidden>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider fixture');
    boundary.origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    changed = false; redirect = false;
    boundary.extract.mockReset().mockResolvedValue({ content: JSON.stringify([{ travelDate: '2026-10-04', price: 711, currency: 'EUR', airline: 'Scandinavian Airlines', stops: 1 }]), usage: { inputTokens: 100, outputTokens: 30 } });
  });
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
  const query = flightLinkQuery(FLIGHT_IMPORT_URL);
  const params = { ...query, sourceUrl: FLIGHT_IMPORT_URL, dateFrom: new Date(query.dateFrom), dateTo: new Date(query.dateTo) };
  const config = { provider: 'openai', model: 'test-model', customBaseUrl: null, apiKey: 'test-key' };

  it('expands the selected legs and records a displayed total with stable flight identity', async () => {
    const result = await scrapeImportedFlight(params, query, config);
    expect(result).toMatchObject({ prices: [{ price: 711, currency: 'EUR', bookingUrl: FLIGHT_IMPORT_URL, flightNumber: 'SK 944' }], usage: { inputTokens: 100, outputTokens: 30 } });
    expect(result.failureReason).toBeUndefined();
  }, 15000);
  it('rejects invented amounts even when the extraction provider returns valid JSON', async () => {
    boundary.extract.mockResolvedValue({ content: JSON.stringify([{ travelDate: '2026-10-04', price: 12, currency: 'EUR', airline: 'Scandinavian Airlines', stops: 1 }]), usage: { inputTokens: 100, outputTokens: 30 } });
    const result = await scrapeImportedFlight(params, query, config);
    expect(result.prices).toEqual([]);
    expect(result.failureReason).toBeTruthy();
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30 });
  }, 15000);
  it('rejects a changed return flight before asking the extraction provider for a price', async () => {
    changed = true;
    await expect(scrapeImportedFlight(params, query, config)).rejects.toThrow(/SK 943/);
    expect(boundary.extract).not.toHaveBeenCalled();
  }, 15000);
  it('blocks a provider redirect into a private network', async () => {
    redirect = true;
    await expect(captureImportedFlight(params)).rejects.toThrow();
  }, 15000);
});
