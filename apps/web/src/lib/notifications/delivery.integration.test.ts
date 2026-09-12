import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../prisma';
import { notifyNewLows } from './run';
import { deliverFlightAlerts } from './flights';
import { deliverHotelAlerts } from '../hotels/alerts';
import { editHotelTracker } from '../hotels/store';
import { runTravelAlertsSafely } from '../travel/schedule';

describe.skipIf(process.env.NOTIFICATION_INTEGRATION_TESTS !== '1')('flight and hotel delivery through PostgreSQL and local HTTP', () => {
  let server: Server, base = '', owner = '', other = '', queryId = '', trackerId = '', cycle: Date;
  let handle: (path: string) => Promise<number>;
  const received: { path: string; data: { eventId: string; currentMin?: number } }[] = [];
  const channels: string[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55416' || url.pathname !== '/flight_test') throw new Error('Notification tests require disposable localhost:55416/flight_test');
    if (process.env.REDIS_URL || await prisma.notificationChannel.count({ where: { enabled: true } })) throw new Error('Notification tests require Redis disabled and no enabled channels');
    server = createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', part => { body += part; });
      request.on('end', () => {
        received.push({ path: request.url!, data: JSON.parse(body).data });
        void handle(request.url!).then(status => { response.writeHead(status); response.end('Fixture response'); }, () => { response.writeHead(500); response.end('Fixture failure'); });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    vi.stubEnv('SELF_HOSTED', 'true'); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    received.length = 0; handle = async () => 200;
    const now = Date.now(); cycle = new Date(now - 45_000);
    owner = (await prisma.user.create({ data: { username: `notification-owner-${crypto.randomUUID()}` } })).id;
    other = (await prisma.user.create({ data: { username: `notification-other-${crypto.randomUUID()}` } })).id;
    const travelDate = new Date(now + 30 * 86_400_000);
    queryId = (await prisma.query.create({ data: { userId: owner, rawInput: 'Fixture flight', origin: 'JFK', originName: 'New York', destination: 'LAX', destinationName: 'Los Angeles',
      dateFrom: travelDate, dateTo: new Date(now + 35 * 86_400_000), expiresAt: new Date(now + 36 * 86_400_000), currency: 'USD' } })).id;
    await prisma.priceSnapshot.createMany({ data: [
      { queryId, travelDate, price: 300, currency: 'USD', airline: 'Fixture Air', scrapedAt: new Date(now - 60_000) },
      { queryId, travelDate, price: 250, currency: 'USD', airline: 'Fixture Air', scrapedAt: new Date(now - 30_000) },
    ] });
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: {}, update: {} });
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { enabled: true, notifyMinDropAbs: 5, notifyMinDropPct: 0, cabinAlertBaselineCutoff: new Date(now - 120_000) } });
    trackerId = '';
  });
  afterEach(async () => {
    await prisma.notificationChannel.deleteMany({ where: { id: { in: channels.splice(0) } } });
    await prisma.query.deleteMany({ where: { id: queryId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await prisma.$disconnect();
  });
  async function channel(path: string) {
    const id = `notification-${path}-${crypto.randomUUID()}`; channels.push(id);
    return prisma.notificationChannel.create({ data: { id, type: 'webhook', config: { url: `${base}/${path}` } } });
  }
  const event = () => prisma.travelAlertDelivery.findFirstOrThrow({ where: { queryId } });
  const retry = () => prisma.travelAlertDelivery.updateMany({ where: { queryId }, data: { nextAttemptAt: new Date(0) } });
  async function hotelEvent() {
    trackerId = (await prisma.hotelTracker.create({ data: { userId: owner, hotelName: 'Fixture hotel', search: {}, selection: {},
      options: { mode: 'best', targetPrice: 100, notifyLows: true, allowApproximateAlerts: false, scrapeInterval: 3 } } })).id;
    return prisma.hotelAlert.create({ data: { trackerId, message: { title: 'Hotel price', body: 'Hotel costs 90 USD', url: 'https://example.com/hotel', data: { price: 90 } } } });
  }

  it('retries a failed price alert after the same fare becomes historical and preserves its event identity', async () => {
    await channel('a'); handle = async () => 503;
    await notifyNewLows([queryId], cycle);
    const first = await event();
    expect(first).toMatchObject({ pending: true, deliveredIds: [] });
    expect((await prisma.query.findUniqueOrThrow({ where: { id: queryId } })).lastNotifiedLowPrice).toBeNull();
    await prisma.priceSnapshot.create({ data: { queryId, travelDate: new Date(Date.now() + 30 * 86_400_000), price: 250, currency: 'USD', airline: 'Fixture Air' } });
    handle = async () => 200; await retry();
    await notifyNewLows([queryId], new Date(Date.now() - 1000));
    expect(await event()).toMatchObject({ pending: false, eventKey: first.eventKey });
    expect(received.map(row => row.data.currentMin)).toEqual([250, 250]);
    expect(new Set(received.map(row => row.data.eventId)).size).toBe(1);
    expect(await prisma.travelAlertDelivery.count({ where: { queryId } })).toBe(1);
  });
  it('retains successful channel receipts when another channel retries without another scrape', async () => {
    const good = await channel('a'); await channel('b');
    handle = async path => path === '/b' ? 503 : 200;
    await notifyNewLows([queryId], cycle);
    expect(await event()).toMatchObject({ pending: true, deliveredIds: [good.id] });
    handle = async () => 200; await retry(); await runTravelAlertsSafely();
    expect(received.map(row => row.path)).toEqual(['/a', '/b', '/b']);
    expect(await event()).toMatchObject({ pending: false });
  });
  it('keeps an event while channels are absent and records it once across concurrent detection', async () => {
    await Promise.all([notifyNewLows([queryId], cycle), notifyNewLows([queryId], cycle)]);
    expect(await prisma.travelAlertDelivery.count({ where: { queryId } })).toBe(1);
    expect(await event()).toMatchObject({ pending: true });
    await channel('a'); await retry(); await deliverFlightAlerts();
    expect(received).toHaveLength(1);
  });
  it('suppresses unchanged prices with zero thresholds even after successful delivery', async () => {
    await channel('a'); await notifyNewLows([queryId], cycle);
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { notifyMinDropAbs: 0, notifyMinDropPct: 0 } });
    await prisma.priceSnapshot.create({ data: { queryId, travelDate: new Date(Date.now() + 30 * 86_400_000), price: 250, currency: 'USD', airline: 'Fixture Air' } });
    await notifyNewLows([queryId], new Date(Date.now() - 1000));
    expect(received).toHaveLength(1);
    expect(await prisma.travelAlertDelivery.count({ where: { queryId } })).toBe(1);
  });
  it('compares the actual currency history instead of a legacy marker in another currency', async () => {
    await prisma.query.update({ where: { id: queryId }, data: { currency: null, lastNotifiedLowPrice: 250 } });
    const now = Date.now(), travelDate = new Date(now + 30 * 86_400_000);
    await prisma.priceSnapshot.createMany({ data: [
      { queryId, travelDate, currency: 'GBP', airline: 'Fixture Air', price: 400, scrapedAt: new Date(now - 20_000) },
      { queryId, travelDate, currency: 'GBP', airline: 'Fixture Air', price: 350, scrapedAt: new Date(now - 5000) },
    ] });
    await channel('a'); await notifyNewLows([queryId], new Date(now - 10_000));
    expect(received.map(row => row.data.currentMin)).toEqual([350]);
    expect((await event()).message).toMatchObject({ data: { currency: 'GBP', baseline: 400, currentMin: 350 } });
  });
  it('establishes and compares a fresh baseline after recorded flight criteria change', async () => {
    const now = Date.now(), travelDate = new Date(now + 30 * 86_400_000);
    await prisma.query.update({ where: { id: queryId }, data: { preferredAirlines: ['New Airline'], lastNotifiedLowPrice: 250 } });
    await prisma.queryEditEvent.create({ data: { queryId, editedAt: new Date(now - 20_000), summary: 'Airlines changed', changes: [{ field: 'preferredAirlines', after: ['New Airline'] }] } });
    await prisma.priceSnapshot.create({ data: { queryId, travelDate, currency: 'USD', airline: 'New Airline', price: 500, scrapedAt: new Date(now - 15_000) } });
    await channel('a'); await notifyNewLows([queryId], new Date(now - 19_000));
    expect(received).toEqual([]);
    await prisma.priceSnapshot.create({ data: { queryId, travelDate, currency: 'USD', airline: 'New Airline', price: 450, scrapedAt: new Date(now - 5000) } });
    await notifyNewLows([queryId], new Date(now - 10_000));
    expect(received.map(row => row.data.currentMin)).toEqual([450]);
    expect((await event()).message).toMatchObject({ data: { baseline: 500, currentMin: 450 } });
  });
  it('keeps a pending flight event when its chart receives its first view', async () => {
    await notifyNewLows([queryId], cycle);
    await prisma.query.update({ where: { id: queryId }, data: { firstViewedAt: new Date() } });
    await channel('a'); await retry(); await deliverFlightAlerts();
    expect(received.map(row => row.data.currentMin)).toEqual([250]);
    expect(await event()).toMatchObject({ pending: false });
  });
  it.each(['owner', 'criteria', 'pause'] as const)('cancels pending flight delivery after a query %s change', async change => {
    await notifyNewLows([queryId], cycle); await channel('a');
    await prisma.query.update({ where: { id: queryId }, data: change === 'owner' ? { userId: other } : change === 'pause' ? { active: false } : { cabinClass: 'business' } });
    await retry(); await deliverFlightAlerts();
    expect(received).toEqual([]); expect(await event()).toMatchObject({ pending: false });
  });
  it.each(['owner', 'expiry', 'replacement'] as const)('does not acknowledge or continue flight delivery after %s changes during transport', async change => {
    await channel('a'); await channel('b');
    const replacement = crypto.randomUUID();
    handle = async () => {
      if (change === 'owner') await prisma.query.update({ where: { id: queryId }, data: { userId: other } });
      else await prisma.travelAlertDelivery.update({ where: { id: (await event()).id }, data: change === 'expiry' ? { claimExpiresAt: new Date(0) } : { claimToken: replacement, lastError: 'Replacement worker' } });
      return 200;
    };
    await notifyNewLows([queryId], cycle);
    expect(received.map(row => row.path)).toEqual(['/a']);
    expect(await event()).toMatchObject({ pending: true, deliveredIds: [], ...(change === 'replacement' ? { claimToken: replacement, lastError: 'Replacement worker' } : {}) });
    expect((await prisma.query.findUniqueOrThrow({ where: { id: queryId } })).lastNotifiedLowPrice).toBeNull();
  });
  it('atomically invalidates premium cabin baselines once across concurrent notification cycles', async () => {
    await prisma.query.update({ where: { id: queryId }, data: { cabinClass: 'business', lastNotifiedLowPrice: 100 } });
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { cabinAlertBaselineCutoff: null } });
    await Promise.all([notifyNewLows([queryId], cycle), notifyNewLows([queryId], cycle)]);
    expect((await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).cabinAlertBaselineCutoff).toBeInstanceOf(Date);
    expect((await prisma.query.findUniqueOrThrow({ where: { id: queryId } })).lastNotifiedLowPrice).toBeNull();
    expect(await prisma.travelAlertDelivery.count({ where: { queryId } })).toBe(0);
  });
  it.each(['pause', 'reassign'] as const)('stops hotel delivery after %s while its first channel is in flight', async action => {
    const alert = await hotelEvent(); await channel('a'); await channel('b');
    handle = async () => {
      await editHotelTracker(trackerId, action === 'pause' ? { active: false } : { userId: other }, { userId: owner, isAdmin: true });
      return 200;
    };
    await deliverHotelAlerts();
    expect(received.map(row => row.path)).toEqual(['/a']);
    expect(await prisma.hotelAlert.findUnique({ where: { id: alert.id } })).toMatchObject({ pending: false, deliveredIds: [] });
  });
  it.each(['expiry', 'replacement'] as const)('does not acknowledge a hotel claim after %s during transport', async change => {
    const alert = await hotelEvent(); await channel('a'); await channel('b');
    const replacement = crypto.randomUUID();
    handle = async () => {
      await prisma.travelAlertDelivery.update({ where: { hotelAlertId: alert.id }, data: change === 'expiry' ? { claimExpiresAt: new Date(0) } : { claimToken: replacement, lastError: 'Replacement worker' } });
      return 200;
    };
    await deliverHotelAlerts();
    expect(received.map(row => row.path)).toEqual(['/a']);
    expect(await prisma.travelAlertDelivery.findUnique({ where: { hotelAlertId: alert.id } })).toMatchObject({ pending: true, deliveredIds: [],
      ...(change === 'replacement' ? { claimToken: replacement, lastError: 'Replacement worker' } : { claimExpiresAt: new Date(0) }) });
  });
  it('preserves legacy hotel delivery receipts while upgrading to fenced claims', async () => {
    const alert = await hotelEvent(); const good = await channel('a'); await channel('b');
    await prisma.hotelAlert.update({ where: { id: alert.id }, data: { deliveredIds: [good.id] } });
    await Promise.all([deliverHotelAlerts(), deliverHotelAlerts()]);
    expect(received.map(row => row.path)).toEqual(['/b']);
    expect(await prisma.hotelAlert.findUnique({ where: { id: alert.id } })).toMatchObject({ pending: false, deliveredIds: expect.arrayContaining([good.id]) });
  });
});
