import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createHotelSearch, createHotelTracker, editHotelTracker, refreshHotelTracker, getHotelTracker, json } from './store';
import { pumpHotelJobs } from './runner';
import { deliverHotelAlerts } from './alerts';
import { prepareStoredConfig } from '@/lib/notifications/channels';
import { PartialHotelSourceError } from './providers';
import { POST as searchRoute } from '@/app/api/hotels/search/route';
import { GET as detailRoute, DELETE as deleteRoute } from '@/app/api/hotels/[id]/route';
import { invalidateMultiUserCache } from '@/lib/multi-user';
import type { HotelOffer } from './types';

const boundary = vi.hoisted(() => ({ search: vi.fn(), cookie: vi.fn() }));
// Provider adapters and request cookies are external I/O boundaries; domain,
// job orchestration, authorization policy and PostgreSQL run normally.
vi.mock('./providers', async original => ({ ...await original<typeof import('./providers')>(), searchHotelSource: boundary.search }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: boundary.cookie }) }));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }));

const enabled = process.env.HOTEL_INTEGRATION_TESTS === '1';
const dates = { checkIn: '2027-04-15', checkOut: '2027-04-18' };
const criteria = { destination: 'London', ...dates, sources: ['booking'], rooms: [{ adults: 2, children: [] }], currency: 'USD' };
const sample: HotelOffer = { id: 'offer-1', source: 'booking', propertyId: 'hotel-1', hotelName: 'Park Hotel', address: 'London', imageUrl: null, propertyUrl: 'https://www.booking.com/hotel/gb/park.html', bookingUrl: 'https://www.booking.com/hotel/gb/park.html', seller: 'Booking.com', roomName: 'Double room', rateName: 'r1', providerRateId: 'rate1', totalPrice: 650, currency: 'USD', taxesIncluded: true, occupancyVerified: true, ...dates, rooms: criteria.rooms, refundable: true, breakfast: true, stars: 4, rating: 9, amenities: {}, match: 'exact' };
const solo = { userId: null, isAdmin: true };
let flightId = '';

describe.skipIf(!enabled)('hotel workflows against isolated PostgreSQL', () => {
  beforeAll(async () => {
    const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (db.hostname !== '127.0.0.1' || db.pathname !== '/hotel_test') throw new Error('Integration tests require the disposable localhost hotel_test database');
    const flight = await prisma.query.create({ data: { rawInput: 'Flight preservation sentinel', origin: 'LHR', originName: 'London', destination: 'JFK', destinationName: 'New York', dateFrom: new Date('2027-05-01'), dateTo: new Date('2027-05-10'), expiresAt: new Date('2027-05-01'), currency: 'GBP', cabinClass: 'business', vpnCountries: ['DE'], scrapeInterval: 6 } });
    flightId = flight.id;
  });
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected external request in integration test')));
    vi.stubEnv('ADMIN_SESSION_SECRET', 'hotel-integration-test-secret');
    process.env.SELF_HOSTED = 'true';
    boundary.search.mockReset().mockResolvedValue([sample]);
    boundary.cookie.mockReturnValue(undefined);
    await prisma.hotelTracker.deleteMany();
    await prisma.hotelSearchRun.deleteMany();
    await prisma.hotelLease.deleteMany();
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { enabled: true, multiUserMode: false, provider: 'anthropic', model: 'flight-model', scrapeInterval: 6 }, update: { enabled: true, multiUserMode: false, provider: 'anthropic', model: 'flight-model', scrapeInterval: 6 } });
    await invalidateMultiUserCache();
  });
  afterAll(async () => {
    if (flightId) await prisma.query.delete({ where: { id: flightId } });
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: false } });
    await invalidateMultiUserCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });
  async function tracked(options: Record<string, unknown> = {}) {
    const run = await createHotelSearch(criteria, solo);
    await pumpHotelJobs();
    return createHotelTracker({ searchId: run.id, offerId: sample.id, targetPrice: 700, ...options }, solo);
  }
  it('searches, persists a selected hotel, records a total and queues its initial alert without touching flights', async () => {
    const tracker = await tracked();
    await pumpHotelJobs();
    const stored = await getHotelTracker(tracker.id, solo);
    expect(Number(stored.latestPrice)).toBe(650);
    expect(await prisma.hotelSnapshot.count({ where: { trackerId: tracker.id, eligible: true } })).toBe(1);
    expect(await prisma.hotelAlert.findFirst({ where: { trackerId: tracker.id } })).toMatchObject({ pending: true, deliveredIds: [] });
    expect(await prisma.query.findUnique({ where: { id: flightId } })).toMatchObject({ cabinClass: 'business', currency: 'GBP', vpnCountries: ['DE'], scrapeInterval: 6 });
    expect(await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } })).toMatchObject({ model: 'flight-model', scrapeInterval: 6 });
  });
  it('rejects invented offers and rejects tracking searches owned by another person', async () => {
    const user = await prisma.user.create({ data: { username: `hotel-${Date.now()}` } });
    const actor = { userId: user.id, isAdmin: false };
    const run = await createHotelSearch(criteria, actor); await pumpHotelJobs();
    await expect(createHotelTracker({ searchId: run.id, offerId: 'fake' }, actor)).rejects.toThrow(/Offer/);
    await expect(createHotelTracker({ searchId: run.id, offerId: sample.id }, { userId: 'other', isAdmin: false })).rejects.toThrow(/not found/);
    await prisma.user.delete({ where: { id: user.id } });
  });
  it('retains successful observations when a different source fails and labels the result partial', async () => {
    boundary.search.mockImplementation(async (_search, _stay, source) => { if (source === 'google_hotels') throw new Error('Provider challenge'); return [sample]; });
    const run = await createHotelSearch({ ...criteria, sources: ['booking', 'google_hotels'] }, solo);
    await pumpHotelJobs();
    const stored = await prisma.hotelSearchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe('partial');
    expect(stored.result).toMatchObject({ completed: 1, total: 2, offers: [expect.objectContaining({ hotelName: sample.hotelName })], errors: [expect.objectContaining({ source: 'google_hotels', message: 'Provider challenge' })] });
  });
  it('does not treat a failed provider request as a sold-out price or rearm an alert', async () => {
    const tracker = await tracked(); await pumpHotelJobs();
    boundary.search.mockRejectedValue(new Error('Browser failed'));
    await refreshHotelTracker(tracker.id, solo); await pumpHotelJobs();
    expect(await prisma.hotelSnapshot.count({ where: { trackerId: tracker.id } })).toBe(1);
    expect(await getHotelTracker(tracker.id, solo)).toMatchObject({ targetArmed: false, lastError: expect.stringContaining('Browser failed') });
  });
  it('deduplicates queued manual refreshes', async () => {
    const tracker = await tracked();
    const first = await refreshHotelTracker(tracker.id, solo);
    const second = await refreshHotelTracker(tracker.id, solo);
    expect(first.id).toBe(second.id);
  });
  it('does not execute cancelled jobs', async () => {
    const run = await createHotelSearch(criteria, solo);
    await prisma.hotelSearchRun.update({ where: { id: run.id }, data: { status: 'cancelled' } });
    await pumpHotelJobs();
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', result: null });
  });
  it('recovers an interrupted worker with a visible failed job', async () => {
    const run = await createHotelSearch(criteria, solo);
    await prisma.hotelSearchRun.update({ where: { id: run.id }, data: { status: 'running' } });
    await pumpHotelJobs();
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
  });
  it('honors a lease held by another process', async () => {
    const run = await createHotelSearch(criteria, solo);
    await prisma.hotelLease.create({ data: { id: 'worker', owner: 'other-process', expiresAt: new Date(Date.now() + 60_000) } });
    await pumpHotelJobs();
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'queued', result: null });
  });
  it('excludes approximate room observations from alerts unless opted in', async () => {
    const tracker = await tracked({ mode: 'room' });
    boundary.search.mockResolvedValue([{ ...sample, match: 'approximate', rateName: null }]);
    await pumpHotelJobs();
    expect(await prisma.hotelSnapshot.findFirst({ where: { trackerId: tracker.id } })).toMatchObject({ eligible: false });
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id } })).toBe(0);
    await editHotelTracker(tracker.id, { allowApproximateAlerts: true }, solo);
    await pumpHotelJobs();
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id } })).toBe(1);
  });
  it('rearms a target after a complete price increase and alerts on the next crossing', async () => {
    const tracker = await tracked(); await pumpHotelJobs();
    boundary.search.mockResolvedValue([{ ...sample, totalPrice: 800 }]);
    await refreshHotelTracker(tracker.id, solo); await pumpHotelJobs();
    expect((await getHotelTracker(tracker.id, solo)).targetArmed).toBe(true);
    boundary.search.mockResolvedValue([{ ...sample, totalPrice: 690 }]);
    await refreshHotelTracker(tracker.id, solo); await pumpHotelJobs();
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id } })).toBe(2);
  });
  it('rearms edited targets while preserving history and cancels pending notifications when paused', async () => {
    const tracker = await tracked(); await pumpHotelJobs();
    await editHotelTracker(tracker.id, { targetPrice: 600 }, solo);
    const changed = await getHotelTracker(tracker.id, solo);
    expect(changed.targetArmed).toBe(true);
    expect(Number(changed.historicalLow)).toBe(650);
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id, pending: true } })).toBe(0);
    await editHotelTracker(tracker.id, { active: false }, solo);
    expect((await getHotelTracker(tracker.id, solo)).active).toBe(false);
  });
  it('alerts on a new historical low after changing the target even when the new target is not reached', async () => {
    const tracker = await tracked(); await pumpHotelJobs();
    await editHotelTracker(tracker.id, { targetPrice: 500 }, solo);
    boundary.search.mockResolvedValue([{ ...sample, totalPrice: 640 }]);
    await pumpHotelJobs();
    const alert = await prisma.hotelAlert.findFirst({ where: { trackerId: tracker.id, pending: true } });
    expect(alert?.message).toMatchObject({ data: { price: 640, target: false, newLow: true } });
    expect(Number((await getHotelTracker(tracker.id, solo)).historicalLow)).toBe(640);
  });
  it('retains the historical baseline and target crossing state when low notifications are toggled', async () => {
    const tracker = await tracked(); await pumpHotelJobs();
    await editHotelTracker(tracker.id, { notifyLows: false }, solo);
    await editHotelTracker(tracker.id, { notifyLows: true }, solo);
    const changed = await getHotelTracker(tracker.id, solo);
    expect(Number(changed.historicalLow)).toBe(650);
    expect(changed.targetArmed).toBe(false);
    boundary.search.mockResolvedValue([{ ...sample, totalPrice: 640 }]);
    await pumpHotelJobs();
    expect((await prisma.hotelAlert.findFirst({ where: { trackerId: tracker.id, pending: true } }))?.message).toMatchObject({ data: { target: false, newLow: true } });
  });
  it('starts a new historical baseline when approximate-offer eligibility changes', async () => {
    const tracker = await tracked(); await pumpHotelJobs();
    await editHotelTracker(tracker.id, { allowApproximateAlerts: true }, solo);
    expect(await getHotelTracker(tracker.id, solo)).toMatchObject({ historicalLow: null, targetArmed: true });
  });
  it('rejects concurrent edits while a check is running', async () => {
    const tracker = await tracked();
    await prisma.hotelSearchRun.create({ data: { trackerId: tracker.id, request: json(criteria), status: 'running' } });
    await expect(editHotelTracker(tracker.id, { targetPrice: 600 }, solo)).rejects.toThrow(/finish/);
  });
  it('caps active searches per owner', async () => {
    await createHotelSearch(criteria, solo); await createHotelSearch(criteria, solo); await createHotelSearch(criteria, solo);
    await expect(createHotelSearch(criteria, solo)).rejects.toThrow(/Three/);
  });
  it('rejects live hotel routes on the informational public site', async () => {
    process.env.SELF_HOSTED = 'false';
    const response = await searchRoute(new Request('http://localhost/api/hotels/search', { method: 'POST', body: JSON.stringify(criteria) }));
    expect(response.status).toBe(404);
  });
  it('requires login before reading hotel history in account mode', async () => {
    const tracker = await tracked();
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: true } });
    await invalidateMultiUserCache();
    const response = await detailRoute(new Request(`http://localhost/api/hotels/${tracker.id}`), { params: Promise.resolve({ id: tracker.id }) });
    expect(response.status).toBe(401);
  });
  it('does not commit prices or alerts after cancellation during extraction', async () => {
    const tracker = await tracked();
    const run = await refreshHotelTracker(tracker.id, solo);
    boundary.search.mockImplementation(async () => {
      await prisma.hotelSearchRun.update({ where: { id: run.id }, data: { status: 'cancelled' } });
      return [sample];
    });
    await pumpHotelJobs();
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'cancelled' });
    expect(await prisma.hotelSnapshot.count({ where: { trackerId: tracker.id } })).toBe(0);
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id } })).toBe(0);
    expect(await getHotelTracker(tracker.id, solo)).toMatchObject({ targetArmed: true, latestPrice: null });
  });
  it('deletes a tracker during extraction without resurrecting its history or alerts', async () => {
    const tracker = await tracked();
    await refreshHotelTracker(tracker.id, solo);
    boundary.search.mockImplementation(async () => {
      const response = await deleteRoute(new Request(`http://localhost/api/hotels/${tracker.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: tracker.id }) });
      expect(response.status).toBe(200);
      return [sample];
    });
    await pumpHotelJobs();
    expect(await prisma.hotelTracker.findUnique({ where: { id: tracker.id } })).toBeNull();
    expect(await prisma.hotelSearchRun.count({ where: { trackerId: tracker.id } })).toBe(0);
    expect(await prisma.hotelSnapshot.count({ where: { trackerId: tracker.id } })).toBe(0);
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id } })).toBe(0);
  });
  it('restricts reassignment to administrators and transfers access while cancelling old queued work', async () => {
    const owner = await prisma.user.create({ data: { username: `hotel-owner-${Date.now()}` } });
    const recipient = await prisma.user.create({ data: { username: `hotel-recipient-${Date.now()}` } });
    try {
      const tracker = await tracked();
      await editHotelTracker(tracker.id, { userId: owner.id }, solo);
      const actor = { userId: owner.id, isAdmin: false };
      const run = await refreshHotelTracker(tracker.id, actor);
      await expect(editHotelTracker(tracker.id, { userId: recipient.id }, actor)).rejects.toThrow(/administrators/);
      await editHotelTracker(tracker.id, { userId: recipient.id }, solo);
      await expect(getHotelTracker(tracker.id, actor)).rejects.toThrow(/not found/);
      expect(await getHotelTracker(tracker.id, { userId: recipient.id, isAdmin: false })).toMatchObject({ userId: recipient.id });
      expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'cancelled' });
    } finally { await prisma.user.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } }); }
  });
  it('does not commit a stale worker result after another process takes its lease', async () => {
    const tracker = await tracked();
    const run = await refreshHotelTracker(tracker.id, solo);
    boundary.search.mockImplementation(async () => {
      await prisma.hotelLease.update({ where: { id: 'worker' }, data: { owner: 'new-worker', expiresAt: new Date(Date.now() + 60_000) } });
      return [sample];
    });
    await pumpHotelJobs();
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'running', result: null });
    expect(await prisma.hotelSnapshot.count({ where: { trackerId: tracker.id } })).toBe(0);
    expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id } })).toBe(0);
  });
  it('merges simultaneous unrelated alert edits without losing either preference', async () => {
    const tracker = await tracked();
    await Promise.all([editHotelTracker(tracker.id, { targetPrice: 500 }, solo), editHotelTracker(tracker.id, { notifyLows: false }, solo)]);
    expect((await getHotelTracker(tracker.id, solo)).options).toMatchObject({ targetPrice: 500, notifyLows: false });
  });
  it('queues one run when scheduled and manual refresh arrive together', async () => {
    const tracker = await tracked();
    await Promise.all([refreshHotelTracker(tracker.id, solo), refreshHotelTracker(tracker.id, solo, true)]);
    expect(await prisma.hotelSearchRun.count({ where: { trackerId: tracker.id, status: 'queued' } })).toBe(1);
  });
  it('keeps verified offers when another property from the same source fails', async () => {
    boundary.search.mockRejectedValue(new PartialHotelSourceError([sample], ['Second property blocked']));
    const run = await createHotelSearch(criteria, solo);
    await pumpHotelJobs();
    const saved = await prisma.hotelSearchRun.findUnique({ where: { id: run.id } });
    expect(saved).toMatchObject({ status: 'partial', error: expect.stringContaining('Second property blocked') });
    expect(saved?.result).toMatchObject({ offers: [{ hotelName: sample.hotelName }], completed: 1 });
  });
  it('allows newer deliverable alerts past a full batch waiting for notification configuration', async () => {
    const oldTracker = await tracked();
    const message = { title: 'Hotel price', body: 'New price', url: 'https://example.com/hotel', data: {} };
    await prisma.hotelAlert.createMany({ data: Array.from({ length: 50 }, () => ({ trackerId: oldTracker.id, message: json(message), nextAttemptAt: new Date(0) })) });
    const owner = await prisma.user.create({ data: { username: `hotel-alert-${Date.now()}` } });
    const owned = await prisma.hotelTracker.create({ data: { hotelName: 'Owned hotel', userId: owner.id, search: json(oldTracker.search), selection: json(oldTracker.selection), options: json(oldTracker.options) } });
    const channel = await prisma.notificationChannel.create({ data: { userId: owner.id, type: 'telegram', config: json(prepareStoredConfig('telegram', { botToken: '123:fake-test-token', chatId: '12345' })) } });
    const wanted = await prisma.hotelAlert.create({ data: { trackerId: owned.id, message: json(message) } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    try {
      await deliverHotelAlerts();
      await deliverHotelAlerts();
      expect(await prisma.hotelAlert.findUnique({ where: { id: wanted.id } })).toMatchObject({ pending: false, deliveredIds: [channel.id] });
      expect(await prisma.hotelAlert.count({ where: { trackerId: oldTracker.id, pending: true, nextAttemptAt: { gt: new Date() } } })).toBe(50);
    } finally { await prisma.user.delete({ where: { id: owner.id } }); }
  });
  it('retries failed notification channels without resending to channels already delivered', async () => {
    const tracker = await tracked();
    const first = await prisma.notificationChannel.create({ data: { type: 'telegram', config: json(prepareStoredConfig('telegram', { botToken: '123:test', chatId: '111' })) } });
    const second = await prisma.notificationChannel.create({ data: { type: 'telegram', config: json(prepareStoredConfig('telegram', { botToken: '456:test', chatId: '222' })) } });
    const message = { title: 'Hotel price', body: 'New price', url: 'https://example.com/hotel', data: {} };
    const alert = await prisma.hotelAlert.create({ data: { trackerId: tracker.id, message: json(message) } });
    const recipients: string[] = [];
    let retry = false;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const recipient = (JSON.parse(String(init.body)) as { chat_id: string }).chat_id;
      recipients.push(recipient);
      return new Response('{}', { status: recipient === '222' && !retry ? 503 : 200 });
    }));
    try {
      await deliverHotelAlerts();
      expect(await prisma.hotelAlert.findUnique({ where: { id: alert.id } })).toMatchObject({ pending: true, deliveredIds: [first.id], lastError: expect.stringContaining('503') });
      retry = true;
      recipients.length = 0;
      await prisma.hotelAlert.update({ where: { id: alert.id }, data: { nextAttemptAt: new Date(0) } });
      await deliverHotelAlerts();
      expect(recipients).toEqual(['222']);
      expect(await prisma.hotelAlert.findUnique({ where: { id: alert.id } })).toMatchObject({ pending: false, deliveredIds: expect.arrayContaining([first.id, second.id]) });
    } finally { await prisma.notificationChannel.deleteMany({ where: { id: { in: [first.id, second.id] } } }); }
  });
  it('skips alerts cancelled by pausing a tracker after the delivery batch was read', async () => {
    const tracker = await tracked();
    const channel = await prisma.notificationChannel.create({ data: { type: 'telegram', config: json(prepareStoredConfig('telegram', { botToken: '123:test', chatId: '111' })) } });
    const message = { title: 'Hotel price', body: 'New price', url: 'https://example.com/hotel', data: {} };
    await prisma.hotelAlert.createMany({ data: [{ trackerId: tracker.id, message: json({ ...message, body: 'First price' }), nextAttemptAt: new Date(0) }, { trackerId: tracker.id, message: json({ ...message, body: 'Second price' }), nextAttemptAt: new Date(1) }] });
    const messages: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      messages.push((JSON.parse(String(init.body)) as { text: string }).text);
      await editHotelTracker(tracker.id, { active: false }, solo);
      return new Response('{}', { status: 200 });
    }));
    try {
      await deliverHotelAlerts();
      expect(messages.some(text => text.includes('First price'))).toBe(true);
      expect(messages.some(text => text.includes('Second price'))).toBe(false);
      expect(await prisma.hotelAlert.count({ where: { trackerId: tracker.id, pending: true } })).toBe(0);
    } finally { await prisma.notificationChannel.delete({ where: { id: channel.id } }); }
  });
});
