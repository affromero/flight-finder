import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { recordFlightAlert, recordFlightAlertInTransaction, deliverFlightAlerts } from '../flights';
import { criteriaVersion } from '../authority/flight';

describe.skipIf(process.env.NOTIFICATION_INTEGRATION_TESTS !== '1')('custom price rules through PostgreSQL and HTTP', () => {
  let server: Server, base = '', queryId = '', owner = '', channelId = '', ruleId = '', cycle: Date;
  let handler: () => Promise<number>;
  const received: { currentMin: number; ruleId?: string }[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55416' || url.pathname !== '/flight_test') throw new Error('Rule tests require disposable localhost:55416/flight_test');
    if (process.env.REDIS_URL || await prisma.notificationChannel.count({ where: { enabled: true } })) throw new Error('Use Redis disabled and no enabled channels');
    server = createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', part => { body += part; });
      request.on('end', () => { received.push(JSON.parse(body).data); void handler().then(status => { response.writeHead(status); response.end('Fixture'); }); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local gateway');
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    received.length = 0; handler = async () => 200; cycle = new Date(Date.now() - 1000);
    owner = (await prisma.user.create({ data: { username: `price-rule-${crypto.randomUUID()}` } })).id;
    const query = await prisma.query.create({ data: { userId: owner, rawInput: 'Rule fixture', origin: 'JFK', originName: 'New York',
      destination: 'LAX', destinationName: 'Los Angeles', dateFrom: new Date('2027-06-15'), dateTo: new Date('2027-06-20'), expiresAt: new Date('2027-06-21'), currency: 'USD' } });
    queryId = query.id;
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: {}, update: {} });
    channelId = (await prisma.notificationChannel.create({ data: { type: 'webhook', config: { url: base } } })).id;
    await prisma.queryAlertSettings.create({ data: { queryId, revision: 1 } });
    ruleId = (await prisma.queryAlertRule.create({ data: { queryId, currency: 'USD', targetPrice: 160, baselinePrice: 200, criteriaVersion: criteriaVersion(query) } })).id;
    await snapshot(200, new Date(Date.now() - 60000)); await snapshot(150);
  });
  afterEach(async () => {
    await prisma.notificationChannel.deleteMany({ where: { id: channelId } });
    await prisma.query.deleteMany({ where: { id: queryId } });
    await prisma.user.deleteMany({ where: { id: owner } });
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await prisma.$disconnect();
  });
  const snapshot = (price: number, scrapedAt = new Date(), changes: Record<string, unknown> = {}) => prisma.priceSnapshot.create({ data: {
    queryId, travelDate: new Date('2027-06-15'), price, currency: 'USD', airline: 'Fixture Air', flightNumber: 'FA100',
    flightId: 'FixtureAir-FA100-JFK-LAX-2027-06-15', departureTime: '08:00', scrapedAt, ...changes,
  } });
  const events = () => prisma.travelAlertDelivery.findMany({ where: { queryId }, orderBy: { createdAt: 'asc' } });
  const rule = () => prisma.queryAlertRule.findUniqueOrThrow({ where: { id: ruleId } });

  it('commits one custom event under concurrent detection and preserves the historical-low compatibility marker', async () => {
    const before = await prisma.query.findUniqueOrThrow({ where: { id: queryId } });
    await Promise.all([recordFlightAlert(queryId, cycle), recordFlightAlert(queryId, cycle)]);
    expect(await events()).toHaveLength(1);
    expect((await events())[0]?.eventKey).toMatch(/^flight-rule:/);
    await deliverFlightAlerts();
    expect(received).toEqual([expect.objectContaining({ queryId, userId: owner, queryVersion: criteriaVersion(before),
      currentMin: 150, currency: 'USD', ruleId, bookingUrl: '', eventId: (await events())[0]?.eventKey })]);
    expect(await rule()).toMatchObject({ eventSequence: 1, lastNotifiedPrice: 150 });
    const after = await prisma.query.findUniqueOrThrow({ where: { id: queryId } });
    expect(after.lastNotifiedLowPrice).toBe(before.lastNotifiedLowPrice);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
  it('keeps a durable trigger available after every channel fails and retries without recording a second event', async () => {
    handler = async () => 503;
    await recordFlightAlert(queryId, cycle); await deliverFlightAlerts();
    expect((await events())[0]).toMatchObject({ pending: true, deliveredIds: [] });
    await recordFlightAlert(queryId, cycle); expect(await events()).toHaveLength(1);
    handler = async () => 200;
    await prisma.travelAlertDelivery.updateMany({ where: { queryId }, data: { nextAttemptAt: new Date(0) } });
    await deliverFlightAlerts();
    expect((await events())[0]).toMatchObject({ pending: false, deliveredIds: [channelId] });
    expect(received).toHaveLength(2);
  });
  it('cancels a queued generic low when custom rules become enabled', async () => {
    await prisma.queryAlertRule.update({ where: { id: ruleId }, data: { enabled: false } });
    await recordFlightAlert(queryId, cycle);
    expect((await events())[0]?.eventKey).toMatch(/^flight:/);
    await prisma.queryAlertRule.update({ where: { id: ruleId }, data: { enabled: true } });
    await deliverFlightAlerts();
    expect(received).toEqual([]);
    expect((await events())[0]).toMatchObject({ pending: false, deliveredIds: [] });
  });
  it('revokes a custom event after the rules collection changes', async () => {
    await recordFlightAlert(queryId, cycle);
    await prisma.queryAlertSettings.update({ where: { queryId }, data: { revision: 2 } });
    await deliverFlightAlerts();
    expect(received).toEqual([]);
    expect((await events())[0]).toMatchObject({ pending: false });
  });
  it('resets the drop baseline and cooldown after a criteria edit', async () => {
    await prisma.queryAlertRule.update({ where: { id: ruleId }, data: { targetPrice: null, dropAbs: 20,
      lastNotifiedPrice: 180, lastNotifiedAt: new Date(), cooldownMinutes: 60 } });
    await prisma.query.update({ where: { id: queryId }, data: { maxStops: 0 } });
    await recordFlightAlert(queryId, cycle);
    expect(await events()).toEqual([]);
    expect(await rule()).toMatchObject({ baselinePrice: 150, lastNotifiedPrice: null, lastNotifiedAt: null });
    await snapshot(120, new Date(Date.now() + 1)); await recordFlightAlert(queryId, cycle);
    expect(await events()).toHaveLength(1);
    expect(await rule()).toMatchObject({ baselinePrice: 120, lastNotifiedPrice: 120, eventSequence: 1 });
  });
  it('never substitutes a cheaper fare in another currency', async () => {
    await prisma.priceSnapshot.deleteMany({ where: { queryId } });
    await snapshot(50, new Date(), { currency: 'EUR' });
    await recordFlightAlert(queryId, cycle);
    expect(await events()).toEqual([]);
    expect(await rule()).toMatchObject({ eventSequence: 0 });
  });
  it('selects the latest unavailable observation before filtering so an earlier cheap fare cannot trigger', async () => {
    await snapshot(150, new Date(Date.now() + 1), { status: 'sold_out' });
    await recordFlightAlert(queryId, cycle);
    expect(await events()).toEqual([]);
  });
  it('rolls back both price observations and rule state with the enclosing scrape transaction', async () => {
    const before = await rule();
    const snapshots = await prisma.priceSnapshot.count({ where: { queryId } });
    await expect(prisma.$transaction(async tx => {
      await tx.priceSnapshot.create({ data: { queryId, travelDate: new Date('2027-06-15'), price: 120, currency: 'USD', airline: 'Fixture Air',
        flightNumber: 'FA100', flightId: 'FixtureAir-FA100-JFK-LAX-2027-06-15', departureTime: '08:00' } });
      await recordFlightAlertInTransaction(tx, queryId, cycle);
      expect(await tx.travelAlertDelivery.count({ where: { queryId } })).toBe(1);
      expect((await tx.queryAlertRule.findUniqueOrThrow({ where: { id: ruleId } })).lastNotifiedPrice).toBe(120);
      throw new Error('Scrape rolled back');
    })).rejects.toThrow(/rolled back/);
    expect(await rule()).toEqual(before);
    expect(await events()).toEqual([]);
    expect(await prisma.priceSnapshot.count({ where: { queryId } })).toBe(snapshots);
  });
  it('refuses to acknowledge an in-flight rule message after its configuration authority changes', async () => {
    await recordFlightAlert(queryId, cycle);
    handler = async () => { await prisma.queryAlertSettings.update({ where: { queryId }, data: { revision: 2 } }); return 200; };
    await deliverFlightAlerts();
    expect(received).toHaveLength(1);
    expect((await events())[0]).toMatchObject({ pending: true, deliveredIds: [] });
    await prisma.travelAlertDelivery.updateMany({ where: { queryId }, data: { nextAttemptAt: new Date(0), claimExpiresAt: new Date(0) } });
    await deliverFlightAlerts();
    expect(received).toHaveLength(1);
    expect((await events())[0]).toMatchObject({ pending: false, deliveredIds: [] });
  });
  it('fails closed when rule metadata is removed instead of decoding it as a legacy low', async () => {
    await recordFlightAlert(queryId, cycle);
    const entry = (await events())[0]!;
    const message = entry.message as Record<string, unknown>;
    const { priceAuthority, ...withoutAuthority } = message;
    expect(priceAuthority).toMatchObject({ kind: 'price-rule' });
    await prisma.travelAlertDelivery.update({ where: { id: entry.id }, data: { message: JSON.parse(JSON.stringify(withoutAuthority)) } });
    await deliverFlightAlerts();
    expect(received).toEqual([]);
    expect((await events())[0]).toMatchObject({ pending: false });
  });
});
