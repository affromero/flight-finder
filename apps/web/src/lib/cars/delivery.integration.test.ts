import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { carOfferFixture, carSearchFixture } from '@/test/car-fixtures';
import { carJson, deleteCarTracker, editCarTracker } from './store';
import { carAlertMessage } from './alerts';
import { deliverCarAlerts } from './delivery';
import { runTravelAlertsSafely } from '../travel/schedule';
import { runHotelJobsSafely } from '../hotels/runner';
import { getCarDetail } from './views';
import { carRecord } from './validation';

describe.skipIf(process.env.CAR_DELIVERY_INTEGRATION_TESTS !== '1')('durable car notification delivery against PostgreSQL and local HTTP', () => {
  let server: Server, base = '', owner = '', other = '', trackerId = '', eventId = '';
  let handle: (path: string) => Promise<number>;
  const received: { path: string; message: { data: { eventId: string } } }[] = [];
  const channelIds: string[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Car delivery tests require disposable localhost:55440/car_test');
    if (await prisma.notificationChannel.count({ where: { enabled: true } })) throw new Error('Delivery tests require no pre-existing enabled channels');
    server = createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', part => { body += part; });
      request.on('end', () => {
        received.push({ path: request.url!, message: JSON.parse(body) });
        void handle(request.url!).then(status => { response.writeHead(status); response.end('Recorded'); }, () => { response.writeHead(500); response.end('Fixture failure'); });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    vi.stubEnv('SELF_HOSTED', 'true'); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    received.length = 0; handle = async () => 200;
    owner = (await prisma.user.create({ data: { username: `car-delivery-owner-${crypto.randomUUID()}` } })).id;
    other = (await prisma.user.create({ data: { username: `car-delivery-other-${crypto.randomUUID()}` } })).id;
    const tracker = await prisma.carTracker.create({ data: { userId: owner, label: 'Weekend rental', currency: 'GBP', search: carJson(carSearchFixture()) } });
    trackerId = tracker.id;
    const message = carAlertMessage(tracker, carOfferFixture(), { currency: 'GBP', minor: 10000 }, { target: true, low: false, state: { targetArmed: false, historicalLowMinor: 10000 } });
    eventId = (await prisma.travelAlertDelivery.create({ data: { carTrackerId: trackerId, eventKey: `car:test:${trackerId}`, message: carJson(message) } })).id;
  });
  afterEach(async () => {
    await prisma.notificationChannel.deleteMany({ where: { id: { in: channelIds.splice(0) } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await prisma.$disconnect();
  });
  async function channel(path: string, userId: string | null = null) {
    const id = `car-delivery-${path}-${crypto.randomUUID()}`;
    channelIds.push(id);
    return prisma.notificationChannel.create({ data: { id, userId, type: 'webhook', config: { url: `${base}/${path}` } } });
  }
  const due = () => prisma.travelAlertDelivery.update({ where: { id: eventId }, data: { nextAttemptAt: new Date(0) } });
  const event = () => prisma.travelAlertDelivery.findUniqueOrThrow({ where: { id: eventId } });

  it('delivers an owned rental event with accounts enabled while rejecting stale solo mutations', async () => {
    const previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } });
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { multiUserMode: true }, update: { multiUserMode: true } });
    try {
      const configured = await channel('multiuser');
      await expect(editCarTracker(trackerId, { active: false }, { userId: null, isAdmin: true })).rejects.toMatchObject({ status: 401 });
      await deliverCarAlerts();
      expect(received.map(row => row.path)).toEqual(['/multiuser']);
      expect(await event()).toMatchObject({ pending: false, deliveredIds: [configured.id], claimToken: null });
    } finally {
      if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: previous.multiUserMode } });
      else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    }
  });

  it('shows actual delivery progression without exposing channel IDs, messages or transport details', async () => {
    const actor = { userId: owner, isAdmin: false };
    expect((await getCarDetail(trackerId, actor)).deliveries).toMatchObject([{ status: 'waiting', acknowledgedChannels: 0 }]);
    await deliverCarAlerts();
    expect((await getCarDetail(trackerId, actor)).deliveries).toMatchObject([{ status: 'retrying', acknowledgedChannels: 0 }]);
    const first = await channel('private-a'); await channel('private-b');
    handle = async path => path === '/private-b' ? 503 : 200;
    await due(); await deliverCarAlerts();
    const partial = await getCarDetail(trackerId, actor);
    expect(partial.deliveries).toMatchObject([{ status: 'retrying', acknowledgedChannels: 1 }]);
    expect(JSON.stringify(partial.deliveries)).not.toContain(first.id);
    expect(JSON.stringify(partial.deliveries)).not.toMatch(/eventKey|claimToken|message|lastError|private-a|private-b/);
    await expect(getCarDetail(trackerId, { userId: other, isAdmin: false })).rejects.toMatchObject({ status: 404 });
    handle = async () => 200; await due(); await deliverCarAlerts();
    expect((await getCarDetail(trackerId, actor)).deliveries).toMatchObject([{ status: 'accepted', acknowledgedChannels: 2, nextAttemptAt: null }]);
  });
  it('bounds delivery history to the newest twenty events for the requested tracker', async () => {
    const createdAt = new Date();
    const records = Array.from({ length: 21 }, (_, index) => ({ id: `delivery-view-${trackerId}-${String(index).padStart(2, '0')}`, carTrackerId: trackerId, eventKey: `delivery-view-${trackerId}-${index}`, message: {}, createdAt }));
    await prisma.travelAlertDelivery.createMany({ data: records });
    const view = await getCarDetail(trackerId, { userId: owner, isAdmin: false });
    expect(view.deliveries.map(row => row.id)).toEqual(records.slice(1).reverse().map(row => row.id));
    expect(view.deliveries.every(row => row.trackerId === trackerId)).toBe(true);
  });
  it('reports a live claim as a reservation and an expired claim as waiting without sending', async () => {
    const actor = { userId: owner, isAdmin: false };
    await prisma.travelAlertDelivery.update({ where: { id: eventId }, data: { claimToken: crypto.randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000) } });
    expect((await getCarDetail(trackerId, actor)).deliveries).toMatchObject([{ status: 'claimed', acknowledgedChannels: 0 }]);
    await prisma.travelAlertDelivery.update({ where: { id: eventId }, data: { claimExpiresAt: new Date(0) } });
    expect((await getCarDetail(trackerId, actor)).deliveries).toMatchObject([{ status: 'waiting', acknowledgedChannels: 0 }]);
    expect(received).toEqual([]);
  });

  it('claims an event once across workers and records its stable identity and channel receipt', async () => {
    const first = await channel('a');
    await Promise.all(Array.from({ length: 4 }, () => deliverCarAlerts()));
    expect(received).toMatchObject([{ path: '/a', message: { data: { eventId: `car:test:${trackerId}` } } }]);
    expect(await event()).toMatchObject({ pending: false, deliveredIds: [first.id], claimToken: null, claimExpiresAt: null, lastError: null });
    await due(); await deliverCarAlerts(); expect(received).toHaveLength(1);
  });
  it('retains an event with no channels and retries when one becomes available', async () => {
    await deliverCarAlerts();
    expect(await event()).toMatchObject({ pending: true, deliveredIds: [], lastError: expect.stringMatching(/No enabled/) });
    await channel('a'); await due(); await deliverCarAlerts();
    expect(await event()).toMatchObject({ pending: false }); expect(received).toHaveLength(1);
  });
  it('retries only failed channels and never routes the event to another user', async () => {
    const good = await channel('a'); await channel('b'); await channel('foreign', other);
    handle = async path => path === '/b' ? 503 : 200;
    await deliverCarAlerts();
    expect(await event()).toMatchObject({ pending: true, deliveredIds: [good.id] });
    handle = async () => 200; await due(); await deliverCarAlerts();
    expect(received.map(row => row.path)).toEqual(['/a', '/b', '/b']);
    expect(await event()).toMatchObject({ pending: false, lastError: null });
  });
  it.each(['pause', 'reassign', 'delete'] as const)('does not start another channel after %s during an accepted delivery', async action => {
    await channel('a'); await channel('b');
    handle = async () => {
      if (action === 'delete') await deleteCarTracker(trackerId, { userId: owner, isAdmin: true });
      else await editCarTracker(trackerId, action === 'pause' ? { active: false } : { userId: other }, { userId: owner, isAdmin: true });
      return 200;
    };
    await deliverCarAlerts(); expect(received.map(row => row.path)).toEqual(['/a']);
    if (action !== 'delete') expect(await event()).toMatchObject({ pending: false, deliveredIds: [] });
    else expect(await prisma.travelAlertDelivery.findUnique({ where: { id: eventId } })).toBeNull();
    if (action !== 'delete') expect((await getCarDetail(trackerId, { userId: owner, isAdmin: true })).deliveries).toMatchObject([{ status: 'stopped', nextAttemptAt: null }]);
  });
  it.each(['disabled', 'reassigned', 'removed'])('rechecks a channel that was %s after batch enumeration', async action => {
    await channel('a'); const second = await channel('b');
    handle = async () => {
      if (action === 'removed') await prisma.notificationChannel.delete({ where: { id: second.id } });
      else await prisma.notificationChannel.update({ where: { id: second.id }, data: action === 'disabled' ? { enabled: false } : { userId: other } });
      return 200;
    };
    await deliverCarAlerts(); expect(received.map(row => row.path)).toEqual(['/a']);
    expect(await event()).toMatchObject({ pending: false });
  });
  it.each(['owner', 'revision', 'payload'])('cancels a stale or corrupt %s event without contacting a channel', async field => {
    await channel('a');
    if (field === 'payload') await prisma.travelAlertDelivery.update({ where: { id: eventId }, data: { message: { title: 'Invalid' } } });
    else await prisma.carTracker.update({ where: { id: trackerId }, data: field === 'owner' ? { userId: other } : { revision: { increment: 1 } } });
    await deliverCarAlerts(); expect(received).toEqual([]);
    expect(await event()).toMatchObject({ pending: false, lastError: expect.stringMatching(/cancelled/) });
  });
  it.each(['discovercars', 'autoeurope'])('cancels an array-valued %s source without contacting a channel', async source => {
    await channel('a');
    const message = carRecord((await event()).message);
    await prisma.travelAlertDelivery.update({ where: { id: eventId }, data: {
      message: carJson({ ...message, data: { ...carRecord(message.data), source: [source] } }),
      claimToken: crypto.randomUUID(), claimExpiresAt: new Date(0),
    } });
    await deliverCarAlerts();
    expect(received).toEqual([]);
    expect(await event()).toMatchObject({ pending: false, deliveredIds: [], claimToken: null, claimExpiresAt: null, lastError: expect.stringMatching(/cancelled/) });
  });
  it.each(['expiry', 'replacement'])('does not acknowledge or overwrite a claim after %s during transport', async change => {
    await channel('a'); await channel('b');
    const replacement = crypto.randomUUID();
    handle = async () => {
      await prisma.travelAlertDelivery.update({ where: { id: eventId }, data: change === 'expiry' ? { claimExpiresAt: new Date(0) } : { claimToken: replacement, lastError: 'New worker state' } });
      return 200;
    };
    await deliverCarAlerts(); expect(received.map(row => row.path)).toEqual(['/a']);
    expect(await event()).toMatchObject({ pending: true, deliveredIds: [], ...(change === 'replacement' ? { claimToken: replacement, lastError: 'New worker state' } : { claimExpiresAt: new Date(0) }) });
  });
  it('stops on acknowledgement storage failure and honestly repeats an accepted but unacknowledged event', async () => {
    await channel('a'); await channel('b');
    await prisma.$executeRawUnsafe('CREATE FUNCTION car_delivery_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'Simulated acknowledgement failure\'; END $$');
    try {
      await prisma.$executeRawUnsafe('CREATE TRIGGER car_delivery_test_fail AFTER UPDATE ON "TravelAlertDelivery" FOR EACH ROW WHEN (cardinality(NEW."deliveredIds") > 0) EXECUTE FUNCTION car_delivery_test_fail()');
      await deliverCarAlerts(); expect(received.map(row => row.path)).toEqual(['/a']);
      expect(await event()).toMatchObject({ pending: true, deliveredIds: [] });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS car_delivery_test_fail ON "TravelAlertDelivery"');
      await prisma.$executeRawUnsafe('DROP FUNCTION car_delivery_test_fail()');
    }
    await due(); await deliverCarAlerts();
    expect(received.map(row => row.path)).toEqual(['/a', '/a', '/b']);
    expect(new Set(received.map(row => row.message.data.eventId)).size).toBe(1);
    expect(await event()).toMatchObject({ pending: false });
  });
  it('does not deliver private events from a public process', async () => {
    await channel('a'); vi.stubEnv('SELF_HOSTED', 'false'); await deliverCarAlerts();
    expect(received).toEqual([]); expect(await event()).toMatchObject({ pending: true, claimToken: null });
  });
  it('returns without sending when the channel table is locked and preserves the retry', async () => {
    await channel('a');
    let locked!: () => void, unlock!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const holding = prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE "NotificationChannel" IN ACCESS EXCLUSIVE MODE');
      locked(); await release;
    }, { timeout: 10_000 });
    await ready;
    try {
      await deliverCarAlerts();
      expect(received).toEqual([]);
      expect(await event()).toMatchObject({ pending: true, deliveredIds: [], claimToken: null, lastError: expect.stringMatching(/interrupted/) });
    } finally { unlock(); await holding; }
    await due(); await deliverCarAlerts();
    expect(received).toHaveLength(1); expect(await event()).toMatchObject({ pending: false });
  });
  it('delivers external-cron alerts with internal timers disabled while the provider queue is stalled', async () => {
    vi.stubEnv('CRON_ENABLED', 'false');
    await channel('a');
    await prisma.carTracker.update({ where: { id: trackerId }, data: { nextCheckAt: new Date(Date.now() + 86_400_000) } });
    const previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { enabled: true } });
    let release!: (rows: []) => void, reading!: () => void;
    const stalled = new Promise<[]>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reading = resolve; });
    const queue = vi.spyOn(prisma.travelJob, 'findMany').mockImplementation(() => { reading(); return stalled as ReturnType<typeof prisma.travelJob.findMany>; });
    let worker: Promise<void> | undefined;
    try {
      await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { enabled: false }, update: { enabled: false } });
      await runTravelAlertsSafely(); expect(received).toEqual([]);
      await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { enabled: true } });
      worker = runHotelJobsSafely(); await entered;
      await expect.poll(async () => (await event()).pending, { timeout: 2000 }).toBe(false);
      expect(received.map(row => row.path)).toEqual(['/a']); expect(await event()).toMatchObject({ pending: false });
    } finally {
      release([]); await worker; queue.mockRestore();
      if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previous });
      else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    }
  });
});
