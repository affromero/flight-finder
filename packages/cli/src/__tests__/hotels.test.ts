import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { HotelClient } from '../lib/hotel-client.js';
import { registerHotelCommands } from '../lib/hotel-cli.js';
import type { HotelSearch } from '../../../../apps/web/src/lib/hotels/types.js';

let server: Server;
let baseUrl: string;
let handle: (request: IncomingMessage, response: ServerResponse) => void;
const search: HotelSearch = { destination: 'London', dateMode: 'fixed', checkIn: '2027-10-15', checkOut: '2027-10-18', flexibility: 0, minNights: 3, maxNights: 3,
  rooms: [{ adults: 2, children: [8] }, { adults: 1, children: [] }], currency: 'GBP', sources: ['booking'],
  filters: { maxTotal: null, refundable: true, breakfast: true, minStars: 4, minRating: 8, excludedSellers: [], amenities: ['parking'] } };
function respond(response: ServerResponse, data: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, data })); }
beforeEach(async () => {
  handle = (request, response) => respond(response, { path: request.url });
  server = createServer((request, response) => handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

describe('hotel HTTP client', () => {
  it('sends account authentication to the selected hotel server', async () => {
    handle = (request, response) => respond(response, { cookie: request.headers.cookie });
    await expect(new HotelClient(baseUrl, 'signed-user-token').request('/api/hotels')).resolves.toEqual({ cookie: 'ft-session=signed-user-token' });
  });
  it('supplies the private-instance access token alongside account credentials', async () => {
    handle = (request, response) => respond(response, { authorization: request.headers.authorization, cookie: request.headers.cookie });
    await expect(new HotelClient(baseUrl, 'session', 'machine-token').request('/api/hotels')).resolves.toEqual({ authorization: 'Bearer machine-token', cookie: 'ft-session=session' });
  });
  it('rejects redirects rather than forwarding credentials to another destination', async () => {
    handle = (request, response) => { response.writeHead(302, { Location: '/login' }); response.end(); };
    await expect(new HotelClient(baseUrl, 'secret').request('/api/hotels')).rejects.toThrow();
  });
  it('explains missing account authentication', async () => {
    handle = (request, response) => { response.writeHead(401); response.end(JSON.stringify({ ok: false, error: 'Authentication required' })); };
    await expect(new HotelClient(baseUrl).request('/api/hotels')).rejects.toThrow('FLIGHT_FINDER_SESSION');
  });
  it('reports unexpected server responses instead of treating them as empty inventory', async () => {
    handle = (request, response) => { response.writeHead(502); response.end('Bad gateway'); };
    await expect(new HotelClient(baseUrl).request('/api/hotels')).rejects.toThrow('502');
  });
  it('preserves room allocations and returns partial offers with provider errors', async () => {
    let submitted: unknown;
    handle = (request, response) => {
      if (request.method === 'POST') {
        let body = ''; request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        request.on('end', () => { submitted = JSON.parse(body); respond(response, { id: 'job', status: 'queued' }, 202); }); return;
      }
      respond(response, { id: 'job', status: 'partial', result: { offers: [{ hotelName: 'Test hotel' }], errors: [{ message: 'Google blocked' }] } });
    };
    const result = await new HotelClient(baseUrl).search(search, { wait: true, intervalMs: 1 });
    expect(submitted).toEqual(search);
    expect(result.result).toMatchObject({ offers: [{ hotelName: 'Test hotel' }], errors: [{ message: 'Google blocked' }] });
  });
  it('cancels the server job when interrupted while waiting', async () => {
    const abort = new AbortController(); let cancelled = false;
    handle = (request, response) => {
      if (request.method === 'DELETE') { cancelled = true; respond(response, {}); return; }
      respond(response, { id: 'job', status: 'running' });
      if (request.method === 'GET') abort.abort(new Error('User cancelled'));
    };
    await expect(new HotelClient(baseUrl).search(search, { wait: true, signal: abort.signal, intervalMs: 1 })).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it('surfaces failed extraction', async () => {
    handle = (request, response) => respond(response, { id: 'job', status: request.method === 'POST' ? 'queued' : 'failed', error: 'Could not verify taxes' });
    await expect(new HotelClient(baseUrl).search(search, { wait: true })).rejects.toThrow('verify taxes');
  });
  it('cancels the server search when the requested wait time expires', async () => {
    let cancelled = false;
    handle = (request, response) => {
      if (request.method === 'DELETE') cancelled = true;
      respond(response, { id: 'job', status: 'running' });
    };
    await expect(new HotelClient(baseUrl).search(search, { wait: true, timeoutMs: 0 })).rejects.toThrow(/timed out/);
    expect(cancelled).toBe(true);
  });
});

describe('hotel commands', () => {
  async function run(args: string[]) {
    const program = new Command(); const handled = registerHotelCommands(program);
    await program.parseAsync(['node', 'flightfinder', 'hotels', '--server', baseUrl, '--json', ...args]);
    expect(handled()).toBe(true);
  }
  it('prints parseable tracker JSON scoped by the server session', async () => {
    vi.stubEnv('FLIGHT_FINDER_SESSION', 'user-session');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = (request, response) => respond(response, { trackers: [{ id: 'owned', session: request.headers.cookie }] });
    await run(['list']);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ trackers: [{ id: 'owned', session: 'ft-session=user-session' }] });
  });
  it('updates only explicitly selected alert settings', async () => {
    let update: unknown;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = (request, response) => { let body = ''; request.on('data', (chunk: Buffer) => { body += chunk.toString(); }); request.on('end', () => { update = JSON.parse(body); respond(response, {}); }); };
    await run(['alerts', 'tracker', '--target', '800']);
    expect(update).toEqual({ targetPrice: 800 });
  });
  it('reports invalid targets as machine-readable errors without modifying a tracker', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await run(['alerts', 'tracker', '--target', '-4']);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ error: expect.stringContaining('positive') });
    expect(process.exitCode).toBe(1);
  });
  it.each([
    ['pause', 'PATCH', '/api/hotels/tracker', { active: false }],
    ['resume', 'PATCH', '/api/hotels/tracker', { active: true }],
    ['delete', 'DELETE', '/api/hotels/tracker', null],
    ['refresh', 'POST', '/api/hotels/tracker/scrape', null],
    ['cancel', 'DELETE', '/api/hotels/search/tracker', null],
  ])('%s sends the requested hotel operation without changing flight settings', async (command, method, path, body) => {
    let operation: unknown;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = (request, response) => {
      let text = ''; request.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      request.on('end', () => { operation = { method: request.method, path: request.url, body: text ? JSON.parse(text) : null }; respond(response, {}); });
    };
    await run([String(command), 'tracker']);
    expect(operation).toEqual({ method, path, body });
  });
  it('creates a specific room tracker with explicitly selected alert conditions', async () => {
    let tracked: unknown;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = (request, response) => { let text = ''; request.on('data', (chunk: Buffer) => { text += chunk.toString(); }); request.on('end', () => { tracked = JSON.parse(text); respond(response, { tracker: { id: 'saved' } }); }); };
    await run(['track', 'search-id', 'offer-id', '--mode', 'room', '--target', '900', '--no-lows', '--approximate', '--interval', '6']);
    expect(tracked).toEqual({ searchId: 'search-id', offerId: 'offer-id', mode: 'room', targetPrice: 900, notifyLows: false, allowApproximateAlerts: true, scrapeInterval: 6 });
  });
  it('uses the server natural-language parser and submits its complete search', async () => {
    let submitted: unknown;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = (request, response) => {
      if (request.url === '/api/hotels/parse') { respond(response, { search }); return; }
      let text = ''; request.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      request.on('end', () => { submitted = JSON.parse(text); respond(response, { id: 'search', status: 'queued' }); });
    };
    await run(['search', '--query', 'London family rooms']);
    expect(submitted).toEqual(search);
  });
  it('clears targets and disables approximation without changing low alerts', async () => {
    let update: unknown;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handle = (request, response) => { let text = ''; request.on('data', (chunk: Buffer) => { text += chunk.toString(); }); request.on('end', () => { update = JSON.parse(text); respond(response, {}); }); };
    await run(['alerts', 'tracker', '--clear-target', '--no-approximate']);
    expect(update).toEqual({ targetPrice: null, allowApproximateAlerts: false });
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '1e307'])('rejects invalid hotel wait timeout %s before starting a search', async (timeout) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let submitted = false;
    handle = (request, response) => { submitted = true; respond(response, {}); };
    await run(['search', '--query', 'London', '--wait', '--timeout', timeout]);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ error: expect.stringContaining('--timeout') });
    expect(submitted).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
