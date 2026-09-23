import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from './prisma';
import { POST as enableAccounts } from '@/app/api/admin/multi-user/route';
import { POST as setup } from '@/app/api/setup/route';
import { POST as createFlight } from '@/app/api/queries/route';
import { GET as setupStatus } from '@/app/api/setup/status/route';
import { GET as setupModels } from '@/app/api/setup/cli-models/route';
import { disableMultiUserMode } from './admin-recovery';
import { createDatabaseSession } from '@/test/database-session';
import { sharedAccess, sharedAccessStore, sharedProfiles } from '@/lib/sidedoor/access/service';
import { acquireTravelLease, claimTravelJob, enqueueTravelJob, guardTravelJob, releaseTravelLease } from './travel/jobs';
import { carJson, createCarSearch, createCarTracker, editCarTracker, refreshCarTracker, deleteCarTracker } from './cars/store';
import { createHotelSearch, editHotelTracker, refreshHotelTracker } from './hotels/store';
import { listCarTrackerPage } from './cars/list';
import { listCarSearchPage } from './cars/search-list';
import { carOfferFixture, carReportFixture, carSearchFixture } from '@/test/car-fixtures';

const boundary = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
const solo = { userId: null, isAdmin: true };
const hotelSearch = { destination: 'London', checkIn: '2027-04-15', checkOut: '2027-04-18', sources: ['booking'], rooms: [{ adults: 2, children: [] }], currency: 'USD' };
const request = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const enable = () => enableAccounts(request('/api/admin/multi-user', {}));

describe.skipIf(process.env.ACCOUNT_INTEGRATION_TESTS !== '1')('account transitions against disposable PostgreSQL', () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/security_test') throw new Error('Account tests require disposable localhost:55442/security_test');
    vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('REDIS_URL', '');
  });
  beforeEach(async () => {
    boundary.token = '';
    await prisma.travelJob.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
    await prisma.query.deleteMany(); await prisma.hotelTracker.deleteMany(); await prisma.hotelSearchRun.deleteMany();
    await prisma.carTracker.deleteMany(); await prisma.carSearchRun.deleteMany(); await prisma.user.deleteMany();
    await prisma.sidedoorState.deleteMany();
    await prisma.extractionConfig.deleteMany();
    await prisma.extractionConfig.create({ data: { id: 'singleton', enabled: false, vpnProvider: 'none' } });
    await sharedAccessStore.initialize();
    boundary.token = await sharedAccess.claimOwner(await sharedAccess.issueOperatorToken(), 'owner', 'account-test-password', 'household');
    const ownerId = (await sharedAccessStore.read()).principals.find((principal) => principal.role === 'owner')!.id;
    await sharedProfiles.select(boundary.token, ownerId);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await prisma.$disconnect(); });

  it('preserves queued rental and hotel work and moves rental history into the first account', async () => {
    const offer = carOfferFixture();
    const completed = await prisma.carSearchRun.create({ data: { request: carJson(carSearchFixture()), result: carJson(carReportFixture([offer])), status: 'success', createdAt: new Date(offer.observedAt), completedAt: new Date() } });
    const tracker = await createCarTracker({ searchId: completed.id, offerId: offer.id, mode: 'best' }, solo);
    const hotel = await createHotelSearch(hotelSearch, solo);
    const flight = await prisma.query.create({ data: { rawInput: 'London to New York', origin: 'LHR', originName: 'London', destination: 'JFK', destinationName: 'New York', dateFrom: new Date('2027-05-01'), dateTo: new Date('2027-05-10'), expiresAt: new Date('2027-05-01') } });
    const seed = await prisma.query.create({ data: { rawInput: 'Public demo', origin: 'LHR', originName: 'London', destination: 'JFK', destinationName: 'New York', dateFrom: new Date('2027-05-01'), dateTo: new Date('2027-05-10'), expiresAt: new Date('2027-05-01'), isSeed: true } });
    const flightJob = await enqueueTravelJob({ kind: 'flight_query', queryId: flight.id, userId: null });
    const response = await enable();
    expect(response.status).toBe(201);
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'owner' } });
    expect((await listCarTrackerPage({ userId: owner.id, isAdmin: true })).trackers.map(row => row.id)).toContain(tracker.id);
    expect((await listCarSearchPage({ userId: owner.id, isAdmin: true })).searches.map(row => row.id)).toContain(completed.id);
    const jobs = await prisma.travelJob.findMany({ where: { kind: { in: ['car_search', 'hotel_search'] } }, include: { hotelRun: true, carRun: true } });
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatchObject({ status: 'queued', userId: owner.id });
      expect(job.hotelRun ?? job.carRun).toMatchObject({ userId: owner.id, status: 'queued' });
    }
    expect(await prisma.hotelSearchRun.findUnique({ where: { id: hotel.id } })).toMatchObject({ userId: owner.id });
    expect(await prisma.query.findUnique({ where: { id: flight.id } })).toMatchObject({ userId: owner.id });
    expect(await prisma.query.findUnique({ where: { id: seed.id } })).toMatchObject({ userId: null });
    expect(await prisma.travelJob.findUnique({ where: { id: flightJob.id } })).toMatchObject({ userId: owner.id, status: 'queued' });
    expect(await prisma.carTrackerCreation.findFirst({ where: { trackerId: tracker.id } })).toMatchObject({ userId: owner.id });
  });

  it('cancels old-owner notification claims before changing ownership', async () => {
    const tracker = await prisma.hotelTracker.create({ data: { hotelName: 'Park Hotel', search: carJson(hotelSearch), selection: { propertyId: 'park', source: 'booking' }, options: { mode: 'best', notifyLows: true, scrapeInterval: 3 } } });
    const alert = await prisma.hotelAlert.create({ data: { trackerId: tracker.id, message: { title: 'Hotel price fell', body: 'Park Hotel is now cheaper' } } });
    const delivery = await prisma.travelAlertDelivery.create({ data: { hotelAlertId: alert.id, eventKey: `hotel:${alert.id}`, message: carJson(alert.message), claimToken: crypto.randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000) } });
    expect((await enable()).status).toBe(201);
    expect(await prisma.hotelAlert.findUnique({ where: { id: alert.id } })).toMatchObject({ pending: false });
    expect(await prisma.travelAlertDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ pending: false, claimToken: null, claimExpiresAt: null });
  });

  it('fences running work without releasing the original worker lease', async () => {
    const run = await createCarSearch(carSearchFixture(), solo);
    const job = await prisma.travelJob.findUniqueOrThrow({ where: { carRunId: run.id } });
    const lease = await acquireTravelLease('browser');
    expect(lease).not.toBeNull();
    await claimTravelJob(job.id, lease!);
    await prisma.carSearchRun.update({ where: { id: run.id }, data: { status: 'running' } });
    expect((await enable()).status).toBe(201);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'cancelled' });
    expect(await prisma.carSearchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'failed', error: expect.stringContaining('Accounts were enabled') });
    expect(await prisma.travelLease.findUnique({ where: { id: lease!.id } })).toMatchObject({ state: 'held', owner: lease!.owner, generation: lease!.generation });
    await expect(prisma.$transaction(tx => guardTravelJob(tx, job.id, lease!))).rejects.toThrow();
    await releaseTravelLease(lease!);
  });

  it('fences an active flight batch while leaving queued instance batches unowned', async () => {
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    const lease = await acquireTravelLease('vpn');
    await claimTravelJob(job.id, lease!);
    expect((await enable()).status).toBe(201);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'cancelled', userId: null });
    expect(await prisma.travelLease.findUnique({ where: { id: lease!.id } })).toMatchObject({ state: 'held' });
    await releaseTravelLease(lease!);
    const queued = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    expect(queued).toMatchObject({ status: 'queued', userId: null });
  });

  it('rejects stale solo search requests after account migration commits', async () => {
    expect((await enable()).status).toBe(201);
    await expect(createCarSearch(carSearchFixture(), solo)).rejects.toMatchObject({ status: 401 });
    await expect(createHotelSearch(hotelSearch, solo)).rejects.toMatchObject({ status: 401 });
    expect(await prisma.travelJob.count()).toBe(0);
  });

  it('rejects a flight request that read solo access before accounts were enabled', async () => {
    let entered!: () => void, resume!: () => void;
    const bodyEntered = new Promise<void>(resolve => { entered = resolve; });
    const bodyReleased = new Promise<void>(resolve => { resume = resolve; });
    const input = { rawInput: 'London to New York', origin: 'LHR', destination: 'JFK', dateFrom: '2027-05-01', dateTo: '2027-05-10', flexibility: 0 };
    const req = request('/api/queries', input);
    vi.spyOn(req, 'json').mockImplementation(async () => { entered(); await bodyReleased; return input; });
    const response = createFlight(req);
    await bodyEntered;
    expect((await enable()).status).toBe(201);
    resume();
    expect((await response).status).toBe(401);
    expect(await prisma.query.count()).toBe(0);
  });

  it('rejects stale solo edits, refreshes and deletions after trackers move to an account', async () => {
    const offer = carOfferFixture();
    const completed = await prisma.carSearchRun.create({ data: { request: carJson(carSearchFixture()), result: carJson(carReportFixture([offer])), status: 'success', createdAt: new Date(offer.observedAt), completedAt: new Date() } });
    const car = await createCarTracker({ searchId: completed.id, offerId: offer.id, mode: 'best' }, solo);
    const hotel = await prisma.hotelTracker.create({ data: { hotelName: 'Park Hotel', search: carJson(hotelSearch), selection: { propertyId: 'park', source: 'booking' }, options: { mode: 'best', notifyLows: true, scrapeInterval: 3 } } });
    expect((await enable()).status).toBe(201);
    await expect(editCarTracker(car.id, { active: false }, solo)).rejects.toMatchObject({ status: 401 });
    await expect(refreshCarTracker(car.id, solo)).rejects.toMatchObject({ status: 401 });
    await expect(deleteCarTracker(car.id, solo)).rejects.toMatchObject({ status: 401 });
    await expect(editHotelTracker(hotel.id, { active: false }, solo)).rejects.toMatchObject({ status: 401 });
    await expect(refreshHotelTracker(hotel.id, solo)).rejects.toMatchObject({ status: 401 });
    expect(await prisma.carTracker.findUnique({ where: { id: car.id } })).toMatchObject({ active: true });
    expect(await prisma.hotelTracker.findUnique({ where: { id: hotel.id } })).toMatchObject({ active: true });
  });

  it('keeps setup and CLI bootstrap closed after disabling and re-enabling accounts', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { setupComplete: true } });
    expect((await enable()).status).toBe(201);
    await disableMultiUserMode();
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'owner' } });
    boundary.token = await createDatabaseSession(owner.id);
    expect((await enable()).status).toBe(201);
    boundary.token = '';
    expect((await setup(request('/api/setup', { provider: 'openai', model: 'gpt-4.1-mini', customBaseUrl: 'https://attacker.example' }))).status).toBe(401);
    expect(await (await setupStatus()).json()).toEqual({ setupComplete: true, needsSetup: false });
    expect((await setupModels(new Request('http://localhost/api/setup/cli-models?provider=codex'))).status).toBe(401);
    expect(await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } })).toMatchObject({ customBaseUrl: null });
  });

  it('keeps first-run setup closed after an owner has been claimed', async () => {
    const responses = await Promise.all(['https://one.example', 'https://two.example'].map(customBaseUrl => setup(request('/api/setup', { provider: 'openai', model: 'gpt-4.1-mini', customBaseUrl }))));
    expect(responses.map(response => response.status)).toEqual([403, 403]);
    expect(await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } })).toMatchObject({ customBaseUrl: null });
  });
});
