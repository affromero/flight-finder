import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { createDatabaseSession } from '@/test/database-session';
import { sharedAccess } from '@/lib/sidedoor/service';
import { carOfferFixture, carReportFixture, carSearchFixture } from '@/test/car-fixtures';
import { carJson, createCarSearch, createCarTracker } from './store';
import { carContractHash } from './selection';
import { carEndpoint } from './http';
import { GET as list, POST as create } from '@/app/api/cars/route';
import { GET as detail, PATCH as edit, DELETE as remove } from '@/app/api/cars/[id]/route';
import { POST as refresh } from '@/app/api/cars/[id]/scrape/route';
import { GET as status, DELETE as cancel } from '@/app/api/cars/search/[id]/route';
import { GET as searches, POST as startSearch } from '@/app/api/cars/search/route';
import { POST as protect } from '@/app/api/cars/search/[id]/protection/route';
import { GET as locations } from '@/app/api/cars/locations/route';
import { GET as session } from '@/app/api/cars/session/route';
import { invalidateMultiUserCache } from '../multi-user';
import { GET as preferences } from '@/app/api/cars/preferences/route';
import { PATCH as setPreferences } from '@/app/api/cars/preferences/[id]/route';
import { PATCH as accountSettings } from '@/app/api/account/settings/route';
import { NextRequest } from 'next/server';

const boundary = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }));
const request = (body?: unknown, method = 'GET', key = crypto.randomUUID()) => new Request('http://localhost/api/cars', { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const refreshRequest = (revision = 0, key = crypto.randomUUID()) => new Request('http://localhost/api/cars/refresh', { method: 'POST', headers: { 'Idempotency-Key': key, 'X-Car-Revision': String(revision) } });

describe.skipIf(process.env.CAR_HTTP_INTEGRATION_TESTS !== '1')('car HTTP ownership, history and request bounds against PostgreSQL', () => {
  let owner = '', other = '';
  let previousConfig: { multiUserMode: boolean; enabled: boolean } | null;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Car HTTP tests require disposable localhost:55440/car_test');
    previousConfig = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { multiUserMode: true, enabled: true } });
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { multiUserMode: true, enabled: false }, update: { multiUserMode: true, enabled: false } });
  });
  beforeEach(async () => {
    vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('REDIS_URL', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    owner = (await prisma.user.create({ data: { username: `car-http-owner-${crypto.randomUUID()}` } })).id;
    other = (await prisma.user.create({ data: { username: `car-http-other-${crypto.randomUUID()}` } })).id;
    boundary.token = await createDatabaseSession(owner);
  });
  afterEach(async () => {
    await prisma.travelJob.deleteMany({ where: { userId: { in: [owner, other] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (previousConfig) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previousConfig });
    else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    await prisma.$disconnect();
  });
  async function completed() {
    return prisma.carSearchRun.create({ data: { userId: owner, request: carJson(carSearchFixture()), result: carJson(carReportFixture()), status: 'success', completedAt: new Date() } });
  }
  const preferenceRequest = (providers: unknown, revision?: number) => new Request('http://localhost/api/cars/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(revision === undefined ? {} : { 'X-Car-Revision': String(revision) }) }, body: JSON.stringify({ providers }) });
  const accountRequest = (body: unknown) => new NextRequest('http://localhost/api/account/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('saves ordered car preferences and resets inheritance without touching flight preferences', async () => {
    await prisma.user.update({ where: { id: owner }, data: { defaultCurrency: 'GBP', preferredAirlines: ['Delta'], preferredAggregators: ['google_flights'] } });
    expect((await (await preferences()).json()).data).toMatchObject({ scope: `user:${owner}`, providers: [], effectiveProviders: ['discovercars', 'autoeurope'], revision: 0 });
    const response = await setPreferences(preferenceRequest(['autoeurope', 'discovercars'], 0), context(owner));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).data).toMatchObject({ providers: ['autoeurope', 'discovercars'], revision: 1 });
    expect((await (await setPreferences(preferenceRequest([], 1), context(owner))).json()).data).toMatchObject({ providers: [], effectiveProviders: ['discovercars', 'autoeurope'], revision: 2 });
    expect(await prisma.user.findUnique({ where: { id: owner } })).toMatchObject({ defaultCurrency: 'GBP', preferredAirlines: ['Delta'], preferredAggregators: ['google_flights'] });
  });
  it('rejects stale retries even when preferences changed away and back to the original values', async () => {
    await setPreferences(preferenceRequest(['autoeurope'], 0), context(owner));
    await setPreferences(preferenceRequest([], 1), context(owner));
    expect((await setPreferences(preferenceRequest(['autoeurope'], 0), context(owner))).status).toBe(412);
    expect((await (await preferences()).json()).data).toMatchObject({ providers: [], revision: 2 });
  });
  it('advances the revision on unchanged web choices but not unrelated account settings', async () => {
    expect((await accountSettings(accountRequest({ preferredCarProviders: [] }))).status).toBe(200);
    expect((await (await preferences()).json()).data.revision).toBe(1);
    expect((await accountSettings(accountRequest({ defaultCurrency: 'EUR' }))).status).toBe(200);
    expect((await (await preferences()).json()).data.revision).toBe(1);
    expect((await setPreferences(preferenceRequest(['discovercars'], 0), context(owner))).status).toBe(412);
  });
  it('serializes concurrent web and CLI preference updates', async () => {
    const [web, cli] = await Promise.all([accountSettings(accountRequest({ preferredCarProviders: ['autoeurope'] })), setPreferences(preferenceRequest(['discovercars'], 0), context(owner))]);
    expect(web.status).toBe(200);
    expect([200, 412]).toContain(cli.status);
    expect((await (await preferences()).json()).data).toMatchObject({ providers: ['autoeurope'], revision: cli.status === 200 ? 2 : 1 });
  });
  it('does not let administrators alter another account or inspect its revision', async () => {
    await prisma.user.update({ where: { id: owner }, data: { isAdmin: true } });
    expect((await setPreferences(preferenceRequest(['autoeurope'], 0), context(other))).status).toBe(404);
    expect(await prisma.user.findUnique({ where: { id: other } })).toMatchObject({ preferredCarProviders: [], carPreferencesRevision: 0 });
  });
  it.each([[['unknown'], 0, 400], [['autoeurope', 'autoeurope'], 0, 400], [[], undefined, 428], [[], 2147483647, 400]] as const)('rejects invalid or unfenced preference updates %#', async (providers, revision, status) => {
    expect((await setPreferences(preferenceRequest(providers, revision), context(owner))).status).toBe(status);
    expect((await (await preferences()).json()).data.revision).toBe(0);
  });
  it('keeps single-user defaults read-only and public preferences unavailable', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: false } });
    await invalidateMultiUserCache();
    try {
      expect((await (await preferences()).json()).data).toMatchObject({ scope: 'single', providers: [], revision: null, savingAllowed: false });
      expect((await setPreferences(preferenceRequest(['autoeurope'], 0), context(owner))).status).toBe(404);
      vi.stubEnv('SELF_HOSTED', 'false');
      expect((await preferences()).status).toBe(404);
    } finally {
      await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: true } });
      await invalidateMultiUserCache();
    }
  });
  async function tracker() {
    const run = await completed();
    return createCarTracker({ searchId: run.id, offerId: 'verified-quote' }, { userId: owner, isAdmin: false });
  }

  it('returns distinct authenticated account scopes and current administrator authority without credentials', async () => {
    const first = await session();
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(await first.json()).toEqual({ ok: true, data: { scope: `user:${owner}`, isAdmin: false } });
    boundary.token = await createDatabaseSession(other);
    await prisma.user.update({ where: { id: other }, data: { isAdmin: true } });
    expect(await (await session()).json()).toEqual({ ok: true, data: { scope: `user:${other}`, isAdmin: true } });
  });
  it('reports single-user scope only when self-hosted account mode is explicitly disabled', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: false } });
    await invalidateMultiUserCache(); boundary.token = '';
    try { expect(await (await session()).json()).toEqual({ ok: true, data: { scope: 'single', isAdmin: true } }); }
    finally {
      await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: true } });
      await invalidateMultiUserCache();
    }
  });

  it('creates a tracker from its owned quote and reports a deduplicated queued refresh', async () => {
    const run = await completed(), response = await create(request({ searchId: run.id, offerId: 'verified-quote' }, 'POST'));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const row = (await response.json()).data.tracker;
    const key = crypto.randomUUID();
    const first = await refresh(refreshRequest(0, key), context(row.id)), second = await refresh(refreshRequest(0, key), context(row.id));
    expect(first.status).toBe(202);
    expect((await first.json()).data).toEqual((await second.json()).data);
    expect(await prisma.travelJob.findMany({ where: { carRun: { trackerId: row.id } } })).toMatchObject([{ status: 'queued', attempts: 0 }]);
    expect((await (await list(request())).json()).data.trackers).toMatchObject([{ id: row.id, latestPriceMinor: null }]);
  });
  it('acknowledges a protected recheck through authenticated HTTP and recovers it without a duplicate job', async () => {
    const run = await completed(), key = crypto.randomUUID(), choiceId = crypto.randomUUID();
    const report = carReportFixture();
    const result = { ...report, protection: [{ offerId: report.offers[0]!.id, status: 'complete', error: null, choices: [{
      id: choiceId, source: 'discovercars', productId: '35', name: 'Full Coverage', termsSummary: 'Reimbursement with exclusions', policyLinks: [],
      observedExtraPrice: { currency: 'GBP', minor: 1800 }, sourceUrl: 'https://www.discovercars.com/offer/coverage/example', observedAt: report.offers[0]!.observedAt,
    }] }] };
    await prisma.carSearchRun.update({ where: { id: run.id }, data: { result: carJson(result), completedAt: new Date() } });
    const body = { offerId: report.offers[0]!.id, choiceId };
    const missingKey = request(body, 'POST'); missingKey.headers.delete('Idempotency-Key');
    expect((await protect(missingKey, context(run.id))).status).toBe(400);
    expect((await protect(request({ ...body, productId: '35' }, 'POST'), context(run.id))).status).toBe(400);
    const response = await protect(request(body, 'POST', key), context(run.id));
    expect(response.status).toBe(202); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const accepted = (await response.json()).data;
    expect(accepted).toMatchObject({ creationKey: key, status: 'queued' });
    expect((await (await protect(request(body, 'POST', key), context(run.id))).json()).data).toEqual(accepted);
    expect((await status(request(), context(accepted.id))).status).toBe(200);
    expect(await prisma.travelJob.count({ where: { userId: owner } })).toBe(1);
    boundary.token = await createDatabaseSession(other);
    await prisma.user.update({ where: { id: other }, data: { isAdmin: true } });
    expect((await protect(request(body, 'POST'), context(run.id))).status).toBe(404);
  });
  it('requires refresh identity and revision and correlates a recovered cancelled check', async () => {
    const row = await tracker(), key = crypto.randomUUID();
    expect((await refresh(request(undefined, 'POST'), context(row.id))).status).toBe(428);
    const missingKey = refreshRequest(); missingKey.headers.delete('Idempotency-Key');
    expect((await refresh(missingKey, context(row.id))).status).toBe(400);
    const first = await refresh(refreshRequest(0, key), context(row.id));
    const accepted = (await first.json()).data;
    expect(accepted).toMatchObject({ trackerId: row.id, refreshKey: key, status: 'queued' });
    await edit(request({ active: false }, 'PATCH'), context(row.id));
    const replay = await refresh(refreshRequest(0, key), context(row.id));
    expect(replay.status).toBe(202);
    expect((await replay.json()).data).toEqual({ ...accepted, status: 'cancelled' });
    expect((await refresh(refreshRequest(0), context(row.id))).status).toBe(412);
    expect(await prisma.carSearchRun.count({ where: { trackerId: row.id } })).toBe(1);
  });
  it('hides every foreign tracker and search operation without changing its state', async () => {
    const row = await tracker(), run = await prisma.carSearchRun.findFirstOrThrow({ where: { trackerId: row.id } });
    boundary.token = await createDatabaseSession(other);
    for (const response of [await detail(request(), context(row.id)), await edit(request({ active: false }, 'PATCH'), context(row.id)), await remove(request(), context(row.id)), await refresh(refreshRequest(), context(row.id)), await status(request(), context(run.id)), await cancel(request(), context(run.id))]) expect(response.status).toBe(404);
    expect((await (await list(request())).json()).data.trackers).toEqual([]);
    expect((await prisma.carTracker.findUniqueOrThrow({ where: { id: row.id } })).active).toBe(true);
    expect((await prisma.carSearchRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('queued');
  });
  it('requires a valid creation key and safely replays an accepted HTTP request', async () => {
    const run = await completed(), input = { searchId: run.id, offerId: 'verified-quote' }, key = crypto.randomUUID();
    for (const invalid of [undefined, '', 'not-a-uuid', `${key}junk`]) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (invalid !== undefined) headers['Idempotency-Key'] = invalid;
      expect((await create(new Request('http://localhost/api/cars', { method: 'POST', headers, body: JSON.stringify(input) }))).status).toBe(400);
    }
    expect(await prisma.carTracker.count({ where: { userId: owner } })).toBe(0);
    const first = await create(request(input, 'POST', key)), retry = await create(request(input, 'POST', key));
    expect(first.status).toBe(201); expect(retry.status).toBe(201);
    const firstData = (await first.json()).data, retryData = (await retry.json()).data, row = firstData.tracker;
    expect(firstData.creationKey).toBe(key); expect(retryData.creationKey).toBe(key);
    expect(retryData.tracker).toEqual(row);
    expect((await create(request({ ...input, label: 'Changed intent' }, 'POST', key))).status).toBe(409);
    await remove(request(), context(row.id));
    expect((await create(request(input, 'POST', key))).status).toBe(410);
  });
  it.each(['public', 'missing', 'revoked'])('rejects %s access before reading data', async mode => {
    if (mode === 'public') vi.stubEnv('SELF_HOSTED', 'false');
    if (mode === 'missing') boundary.token = '';
    if (mode === 'revoked') await sharedAccess.store.transact(state => { state.principals.find(principal => principal.id === owner)!.epoch++; });
    const identity = await session();
    expect(identity.status).toBe(mode === 'public' ? 404 : 401);
    expect(identity.headers.get('cache-control')).toBe('private, no-store');
    expect((await list(request())).status).toBe(mode === 'public' ? 404 : 401);
    expect((await create(request({}, 'POST'))).status).toBe(mode === 'public' ? 404 : 401);
    expect((await startSearch(request({}, 'POST'))).status).toBe(mode === 'public' ? 404 : 401);
    expect((await protect(request({}, 'POST'), context('unread-parent'))).status).toBe(mode === 'public' ? 404 : 401);
    expect((await searches(request())).status).toBe(mode === 'public' ? 404 : 401);
    expect((await locations(new Request('http://localhost/api/cars/locations?q=LHR'))).status).toBe(mode === 'public' ? 404 : 401);
  });
  it('creates a catalog search through authenticated HTTP and recovers its exact acknowledgement', async () => {
    const found = await locations(new Request('http://localhost/api/cars/locations?q=LHR'));
    expect(found.status).toBe(200);
    const place = (await found.json()).data[0], criteria = carSearchFixture(), key = crypto.randomUUID();
    const body = { pickup: { id: place.id, version: place.version }, dropoff: { id: place.id, version: place.version }, pickupAt: { date: criteria.pickupAt.date, time: criteria.pickupAt.time }, dropoffAt: { date: criteria.dropoffAt.date, time: criteria.dropoffAt.time }, driver: criteria.driver, currency: criteria.currency, sources: criteria.sources };
    const accepted = await startSearch(request(body, 'POST', key));
    expect(accepted.status).toBe(202); expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    const first = (await accepted.json()).data;
    expect(first).toMatchObject({ status: 'queued', creationKey: key });
    expect((await (await startSearch(request(body, 'POST', key))).json()).data).toEqual(first);
    expect((await (await searches(request())).json()).data.searches).toMatchObject([{ id: first.id, status: 'queued' }]);
    boundary.token = await createDatabaseSession(other);
    expect((await (await searches(request())).json()).data.searches).toEqual([]);
    expect((await status(request(), context(first.id))).status).toBe(404);
  }, 20_000);
  it('requires explicit authorized administration and keeps an administrator’s normal list personal', async () => {
    const row = await tracker();
    boundary.token = await createDatabaseSession(other);
    const adminRequest = new Request('http://localhost/api/cars?admin=true');
    expect((await list(adminRequest)).status).toBe(403);
    await prisma.user.update({ where: { id: other }, data: { isAdmin: true } });
    expect((await (await list(request())).json()).data.trackers).toEqual([]);
    expect((await (await list(adminRequest)).json()).data.trackers).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.id })]));
  });
  it('returns owned rental pages with explicit continuation and rejects invalid pagination inputs', async () => {
    const createdAt = new Date(Date.now() - 1000);
    await prisma.carTracker.createMany({ data: [owner, other].flatMap(userId => Array.from({ length: 3 }, (_, index) => ({ id: `${userId}-${index}`, userId, label: `Rental ${index}`, search: carJson(carSearchFixture()), currency: 'GBP', createdAt }))) });
    const first = await list(new Request('http://localhost/api/cars?limit=2'));
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('private, no-store');
    const page = (await first.json()).data;
    expect(page.trackers.map((row: { id: string }) => row.id)).toEqual([`${owner}-2`, `${owner}-1`]);
    const next = new Request(`http://localhost/api/cars?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`);
    expect((await (await list(next)).json()).data).toMatchObject({ trackers: [{ id: `${owner}-0` }], nextCursor: null });
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=01', 'limit=', 'cursor=bad!']) expect((await list(new Request(`http://localhost/api/cars?${query}`))).status).toBe(400);
    boundary.token = await createDatabaseSession(other);
    expect((await list(next)).status).toBe(400);
    boundary.token = '';
    expect((await list(next)).status).toBe(401);
  });
  it('keeps old verified history readable without allowing it to become a fresh tracker quote', async () => {
    const row = await tracker(), observedAt = new Date(Date.now() - 30 * 86_400_000), offer = carOfferFixture(observedAt.toISOString());
    const run = await prisma.carSearchRun.create({ data: { userId: owner, trackerId: row.id, trackerRevision: 0, request: row.search!, result: carJson(carReportFixture([offer])), status: 'success', createdAt: observedAt, completedAt: observedAt } });
    await prisma.carSnapshot.create({ data: { trackerId: row.id, runId: run.id, source: 'discovercars', offer: carJson(offer), currency: 'GBP', totalMinor: 10000, eligible: true, reasons: [], contractHash: carContractHash(offer.contract), observedAt } });
    const response = await detail(request(), context(row.id));
    expect(response.status).toBe(200);
    expect((await response.json()).data.snapshots).toMatchObject([{ totalMinor: 10000, eligible: true, observedAt: observedAt.toISOString() }]);
    expect((await status(request(), context(run.id))).status).toBe(200);
    expect((await create(request({ searchId: run.id, offerId: offer.id }, 'POST'))).status).toBe(409);
  });
  it('reports the selected provider for an exact-contract refresh without changing the stored search', async () => {
    const source = await completed();
    const row = await createCarTracker({ searchId: source.id, offerId: 'verified-quote', mode: 'contract' }, { userId: owner, isAdmin: false });
    const run = await prisma.carSearchRun.findFirstOrThrow({ where: { trackerId: row.id } });
    const response = await status(request(), context(run.id));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: run.id, trackerId: row.id, status: 'queued', search: { sources: ['discovercars'] } });
    expect((await prisma.carSearchRun.findUniqueOrThrow({ where: { id: run.id } })).request).toEqual(run.request);
    const offer = carOfferFixture();
    await prisma.carSearchRun.update({ where: { id: run.id }, data: { status: 'success', completedAt: new Date(), result: carJson(carReportFixture([offer], ['discovercars'])) } });
    const done = await status(request(), context(run.id));
    expect(done.status).toBe(200);
    expect((await done.json()).data.result).toMatchObject({ total: 1, completed: 1, offers: [{ id: offer.id }] });
  });
  it.each(['best', 'contract'] as const)('retains the verified %s observation beyond the recent history window after failed checks', async mode => {
    const source = await completed(), row = await createCarTracker({ searchId: source.id, offerId: 'verified-quote', mode }, { userId: owner, isAdmin: false });
    const originalTime = new Date(Date.now() - 3 * 3_600_000), original = carOfferFixture(originalTime.toISOString());
    const originalRun = await prisma.carSearchRun.create({ data: { trackerId: row.id, userId: owner, request: row.search!, status: 'success', createdAt: originalTime, completedAt: originalTime } });
    const verified = await prisma.carSnapshot.create({ data: { trackerId: row.id, runId: originalRun.id, source: 'discovercars', offer: carJson(original), currency: 'GBP', totalMinor: 10000, eligible: true, reasons: [], contractHash: carContractHash(original.contract), observedAt: originalTime } });
    if (mode === 'contract') {
      const observedAt = new Date(originalTime.getTime() + 60_000), mismatched = carOfferFixture(observedAt.toISOString());
      mismatched.contract.fuelPolicy = 'Return empty';
      const run = await prisma.carSearchRun.create({ data: { trackerId: row.id, userId: owner, request: row.search!, status: 'success', createdAt: observedAt, completedAt: observedAt } });
      await prisma.carSnapshot.create({ data: { trackerId: row.id, runId: run.id, source: 'discovercars', offer: carJson(mismatched), currency: 'GBP', totalMinor: 10000, eligible: true, reasons: [], contractHash: carContractHash(mismatched.contract), observedAt } });
    }
    const newer = Array.from({ length: 101 }, (_, index) => ({ id: crypto.randomUUID(), time: new Date(Date.now() - 2 * 3_600_000 + index * 60_000) }));
    await prisma.carSearchRun.createMany({ data: newer.map(entry => ({ id: entry.id, trackerId: row.id, userId: owner, request: row.search!, status: 'partial', createdAt: entry.time, completedAt: entry.time })) });
    await prisma.carSnapshot.createMany({ data: newer.map(entry => {
      const offer = carOfferFixture(entry.time.toISOString()); offer.taxesIncluded.status = 'unknown';
      return { trackerId: row.id, runId: entry.id, source: 'discovercars', offer: carJson(offer), currency: 'GBP', totalMinor: 10000, eligible: false, reasons: ['Tax inclusion was not verified'], contractHash: carContractHash(offer.contract), observedAt: entry.time };
    }) });
    await prisma.carTracker.update({ where: { id: row.id }, data: { latestPriceMinor: 10000, lastCheckedAt: new Date(), lastError: 'Latest check failed' } });
    const response = await detail(request(), context(row.id)); expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.snapshots).toHaveLength(100); expect(data.snapshots.every((entry: { eligible: boolean }) => !entry.eligible)).toBe(true);
    expect(data.latestObservation).toMatchObject({ id: verified.id, observedAt: originalTime.toISOString(), totalMinor: 10000, eligible: true });
    expect(data.tracker.lastCheckedAt).not.toBe(data.latestObservation.observedAt);
  });
  it('uses the most recently evaluated matching observation when equal prices repeat', async () => {
    const row = await tracker(), base = Date.now() - 60_000;
    let expected = '';
    for (const index of [0, 1]) {
      const observedAt = new Date(base - index * 1000), evaluatedAt = new Date(base + index * 1000), offer = carOfferFixture(observedAt.toISOString());
      const run = await prisma.carSearchRun.create({ data: { trackerId: row.id, userId: owner, request: row.search!, status: 'success', createdAt: observedAt, completedAt: evaluatedAt } });
      expected = (await prisma.carSnapshot.create({ data: { trackerId: row.id, runId: run.id, source: 'discovercars', offer: carJson(offer), currency: 'GBP', totalMinor: 10000, eligible: true, reasons: [], contractHash: carContractHash(offer.contract), observedAt } })).id;
    }
    await prisma.carTracker.update({ where: { id: row.id }, data: { latestPriceMinor: 10000 } });
    const response = await detail(request(), context(row.id)); expect(response.status).toBe(200);
    expect((await response.json()).data.latestObservation.id).toBe(expected);
  });
  it('allows only one concurrent settings request to advance a given tracker revision', async () => {
    const row = await tracker();
    const conditional = () => { const r = request({ label: 'Updated weekend' }, 'PATCH'); r.headers.set('X-Car-Revision', '0'); return r; };
    const responses = await Promise.all([edit(conditional(), context(row.id)), edit(conditional(), context(row.id))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 412]);
    const current = await detail(request(), context(row.id));
    expect(current.headers.get('X-Car-Revision')).toBe('1');
    expect((await current.json()).data.tracker).toMatchObject({ label: 'Updated weekend', revision: 1 });
  });
  it('rejects a late edit and deletion before disturbing newer queued work or alerts', async () => {
    const row = await tracker();
    const editAt = (revision: number, label: string) => { const r = request({ label }, 'PATCH'); r.headers.set('X-Car-Revision', String(revision)); return edit(r, context(row.id)); };
    expect((await editAt(0, 'First acknowledged state')).status).toBe(200);
    expect((await editAt(1, 'Newer intentional state')).status).toBe(200);
    expect((await refresh(refreshRequest(2), context(row.id))).status).toBe(202);
    const queued = await prisma.travelJob.findMany({ where: { carRun: { trackerId: row.id }, status: 'queued' } });
    const alert = await prisma.travelAlertDelivery.create({ data: { carTrackerId: row.id, eventKey: `revision-test-${row.id}`, message: { title: 'Test notification' } } });
    expect((await editAt(0, 'Late retry')).status).toBe(412);
    const deletion = request(undefined, 'DELETE'); deletion.headers.set('X-Car-Revision', '1');
    expect((await remove(deletion, context(row.id))).status).toBe(412);
    expect(await prisma.travelJob.findMany({ where: { carRun: { trackerId: row.id }, status: 'queued' } })).toEqual(queued);
    expect(await prisma.travelAlertDelivery.findUniqueOrThrow({ where: { id: alert.id } })).toEqual(alert);
    expect((await prisma.carTracker.findUniqueOrThrow({ where: { id: row.id } })).label).toBe('Newer intentional state');
  });
  it.each(['-1', '1.5', '01', '2147483648', '1,2', '"1"', 'NaN'])('rejects malformed revision header %s without changing the tracker', async value => {
    const row = await tracker(), update = request({ active: false }, 'PATCH'); update.headers.set('X-Car-Revision', value);
    expect((await edit(update, context(row.id))).status).toBe(400);
    const deletion = request(undefined, 'DELETE'); deletion.headers.set('X-Car-Revision', value);
    expect((await remove(deletion, context(row.id))).status).toBe(400);
    expect(await prisma.carTracker.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ active: true, revision: 0 });
  });
  it('preserves owned search visibility across tracker reassignment without exposing the tracker', async () => {
    const row = await tracker(), run = await prisma.carSearchRun.findFirstOrThrow({ where: { trackerId: row.id } });
    await prisma.user.update({ where: { id: owner }, data: { isAdmin: true } });
    expect((await edit(request({ userId: other }, 'PATCH'), context(row.id))).status).toBe(200);
    await prisma.user.update({ where: { id: owner }, data: { isAdmin: false } });
    expect((await detail(request(), context(row.id))).status).toBe(404);
    expect((await status(request(), context(run.id))).status).toBe(200);
    const retry = request({ label: 'Late owner request' }, 'PATCH'); retry.headers.set('X-Car-Revision', '0');
    expect((await edit(retry, context(row.id))).status).toBe(404);
    boundary.token = await createDatabaseSession(other);
    expect((await detail(request(), context(row.id))).status).toBe(200);
    expect((await status(request(), context(run.id))).status).toBe(404);
  });
  it('pauses and cancels queued work and refuses refresh until resumed', async () => {
    const row = await tracker();
    expect((await edit(request({ active: false }, 'PATCH'), context(row.id))).status).toBe(200);
    expect((await refresh(refreshRequest(1), context(row.id))).status).toBe(409);
    const run = await createCarSearch(carSearchFixture(), { userId: owner, isAdmin: false });
    expect((await (await cancel(request(), context(run.id))).json()).data.status).toBe('cancelled');
    expect((await (await cancel(request(), context(run.id))).json()).data.status).toBe('cancelled');
    expect((await remove(request(), context(row.id))).status).toBe(200);
    expect((await detail(request(), context(row.id))).status).toBe(404);
  });
  it('rejects malformed JSON and chunked oversized bodies before creating a tracker', async () => {
    expect((await create(new Request('http://localhost/api/cars', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status).toBe(400);
    expect((await create(new Request('http://localhost/api/cars', { method: 'POST', body: '{}' }))).status).toBe(415);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(40_000)); controller.close(); } });
    const oversized = new Request('http://localhost/api/cars', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect((await create(oversized)).status).toBe(413);
    expect(await prisma.carTracker.count({ where: { userId: owner } })).toBe(0);
  });
  it('returns a bounded generic error for corrupt history instead of leaking stored data', async () => {
    const row = await tracker();
    await prisma.carTracker.update({ where: { id: row.id }, data: { search: { secret: 'private-corrupt-payload' } } });
    const response = await detail(request(), context(row.id));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-corrupt-payload');
  });
  it.each([10001n, 9007199254740992n])('rejects inconsistent or unsafe historical amounts at the read or storage boundary: %s', async totalMinor => {
    const row = await tracker(), offer = carOfferFixture(), run = await prisma.carSearchRun.findFirstOrThrow({ where: { trackerId: row.id } });
    const writing = prisma.carSnapshot.create({ data: { trackerId: row.id, runId: run.id, source: 'discovercars', offer: carJson(offer), currency: 'GBP', totalMinor, eligible: true, reasons: [], contractHash: carContractHash(offer.contract), observedAt: new Date(offer.observedAt) } });
    if (totalMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
      await expect(writing).rejects.toThrow(/CarSnapshot_amount_check/);
      expect((await (await detail(request(), context(row.id))).json()).data.snapshots).toEqual([]);
      return;
    }
    await writing;
    const response = await detail(request(), context(row.id));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/Stored rental history is invalid/);
  });
  it('does not expose an unverified quote as eligible history even when its stored flag is corrupted', async () => {
    const row = await tracker(), offer = carOfferFixture(), run = await prisma.carSearchRun.findFirstOrThrow({ where: { trackerId: row.id } });
    offer.taxesIncluded.status = 'unknown';
    await prisma.carSnapshot.create({ data: { trackerId: row.id, runId: run.id, source: 'discovercars', offer: carJson(offer), currency: 'GBP', totalMinor: 10000, eligible: true, reasons: [], contractHash: carContractHash(offer.contract), observedAt: new Date(offer.observedAt) } });
    expect((await detail(request(), context(row.id))).status).toBe(500);
  });
  it('maps transaction conflicts to retryable responses and redacts unexpected backend exceptions', async () => {
    const conflict = await carEndpoint(async () => { throw Object.assign(new Error('Private query detail'), { code: 'P2034' }); });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain('Private query detail');
    const failure = await carEndpoint(async () => { throw new Error('Private query detail'); });
    expect(failure.status).toBe(500);
    expect(failure.headers.get('cache-control')).toBe('private, no-store');
    expect(await failure.text()).not.toContain('Private query detail');
  });
});
