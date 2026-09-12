import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { routeProviderTransport } from '@/test/provider-transport';
import { POST as createSearch } from '@/app/api/hotels/search/route';
import { GET as searchStatus, DELETE as cancelSearch } from '@/app/api/hotels/search/[id]/route';
import { GET as recoveryStatus, POST as recover } from '@/app/api/admin/travel/route';
import { createHotelSearch } from '../hotels/store';
import { pumpTravelJobs } from './coordinator';

const boundary = vi.hoisted(() => ({ origin: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }));
vi.mock('playwright', async original => {
  const actual = await original<typeof import('playwright')>();
  return { ...actual, chromium: { ...actual.chromium, launch: async (options: Parameters<typeof actual.chromium.launch>[0]) => routeProviderTransport(await actual.chromium.launch(options), boundary.origin) } };
});

describe.skipIf(process.env.TRAVEL_COORDINATOR_INTEGRATION_TESTS !== '1')('reported quarantine through HTTP, PostgreSQL and Chromium hotel search', () => {
  let server: Server;
  let previous: { multiUserMode: boolean; vpnProvider: string | null; enabled: boolean } | null;
  const arrival = new Date(); arrival.setUTCMonth(arrival.getUTCMonth() + 2, 15);
  const departure = new Date(arrival); departure.setUTCDate(departure.getUTCDate() + 3);
  const search = { destination: 'Selected Hotel', checkIn: arrival.toISOString().slice(0, 10), checkOut: departure.toISOString().slice(0, 10), sources: ['booking'], rooms: [{ adults: 2, children: [] }], currency: 'GBP' };
  const actor = { userId: null, isAdmin: true };
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = () => new Request('http://localhost/api/hotels/search');
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Recovery search tests require disposable localhost:55440/car_test');
    previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { multiUserMode: true, vpnProvider: true, enabled: true } });
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname.endsWith('/searchresults.html')) {
        response.end('<a href="https://www.booking.com/hotel/gb/selected.html">Selected Hotel</a>'); return;
      }
      response.end(`<h1>Selected Hotel</h1><input type="hidden" name="checkin" value="${search.checkIn}"><input type="hidden" name="checkout" value="${search.checkOut}"><input type="hidden" name="interval" value="3"><input type="hidden" name="room1" value="A,A"><table><thead><tr><th>Price for 3 nights</th></tr></thead><tbody><tr><td><div data-testid="room-name">Double room</div><div>Sleeps: 2 adults</div><div>Current price £450</div><div>Includes taxes and fees</div><div>Free cancellation</div><div>Breakfast included</div><select name="nr_rooms_double_rate"><option value="0">0</option><option value="2">2</option></select></td></tr></tbody></table>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider fixture');
    boundary.origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('REDIS_URL', '');
    await prisma.travelJob.deleteMany(); await prisma.hotelSearchRun.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { enabled: true, multiUserMode: false, vpnProvider: 'none' }, update: { enabled: true, multiUserMode: false, vpnProvider: 'none' } });
    // This is an existing incident, including the exact reason reported in #207.
    await prisma.travelAdmission.create({ data: { quarantinedAt: new Date(), recoveryGeneration: 1,
      quarantineReason: 'A travel worker stopped without verified cleanup. Stop old workers and verify the network before recovery.' } });
  });
  afterEach(async () => {
    await prisma.travelJob.deleteMany(); await prisma.hotelSearchRun.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previous });
    else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    await prisma.$disconnect();
  });
  it('explains the pause, recovers the existing incident, and completes the same queued hotel search', async () => {
    const run = await createHotelSearch(search, actor);
    const blocked = await searchStatus(request(), context(run.id));
    expect(blocked.status).toBe(503);
    expect((await blocked.json()).error).toMatch(/Open \/admin.*retry/);
    await pumpTravelJobs();
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'queued' });
    const status = (await (await recoveryStatus()).json()).data;
    const response = await recover(new Request('http://localhost/api/admin/travel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorScope: status.actorScope, generation: status.recoveryGeneration, oldWorkersStopped: true, networkVerified: true }) }));
    expect(response.status).toBe(200);
    expect((await searchStatus(request(), context(run.id))).status).toBe(200);
    await pumpTravelJobs();
    const completed = await searchStatus(request(), context(run.id));
    expect(completed.status).toBe(200);
    expect((await completed.json()).data).toMatchObject({ id: run.id, status: 'success', error: null,
      result: { offers: [expect.objectContaining({ hotelName: 'Selected Hotel', totalPrice: 450, currency: 'GBP', taxesIncluded: true, occupancyVerified: true })] } });
  }, 30_000);
  it('rejects a new hotel search with recovery guidance while keeping cancellation and completed history available', async () => {
    const rejected = await createSearch(new Request('http://localhost/api/hotels/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(search) }));
    expect(rejected.status).toBe(503);
    expect((await rejected.json()).error).toContain('/admin');
    expect(await prisma.hotelSearchRun.count()).toBe(0);
    const run = await createHotelSearch(search, actor);
    expect((await cancelSearch(request(), context(run.id))).status).toBe(200);
    const cancelled = await searchStatus(request(), context(run.id));
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).data.status).toBe('cancelled');
    const finished = await prisma.hotelSearchRun.create({ data: { request: search, status: 'success', completedAt: new Date(), result: { offers: [], errors: [], completed: 1, total: 1 } } });
    const history = await searchStatus(request(), context(finished.id));
    expect(history.status).toBe(200);
    expect((await history.json()).data.status).toBe('success');
  });
});
