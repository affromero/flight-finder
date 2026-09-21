import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessService, PrincipalManagement } from 'thesidedoor-core/access';
import { NextRequest } from 'next/server';
import type { PrismaClient } from '@/generated/prisma/client';
import type { FlightFinderAccessStore } from './access-store';
async function initializeProviderCredentials() {
  return (await import('../providers/provider-credentials')).initializeProviderCredentials();
}

const databaseUrl = process.env.SIDEDOOR_TEST_DATABASE_URL;
const cookieBoundary = vi.hoisted(() => ({ token: '' }));
const schedulerBoundary = vi.hoisted(() => ({ started: [] as string[] }));
vi.mock('@/lib/cron', async original => ({ ...await original<typeof import('@/lib/cron')>(), startCron: async () => { schedulerBoundary.started.push('cron'); } }));
vi.mock('@/lib/travel/schedule', async original => ({ ...await original<typeof import('@/lib/travel/schedule')>(), startTravelScheduler: () => { schedulerBoundary.started.push('travel'); } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => cookieBoundary.token ? { value: cookieBoundary.token } : undefined }) }));
let prisma: PrismaClient;
let store: FlightFinderAccessStore;
let service: AccessService;

describe.skipIf(!databaseUrl)('shared access with PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/sidedoor_test')
      throw new Error('Access integration tests require the dedicated local sidedoor_test database');
    process.env.DATABASE_URL = databaseUrl;
    prisma = (await import('@/lib/prisma')).prisma;
    const { FlightFinderAccessStore } = await import('./access-store');
    store = new FlightFinderAccessStore();
    service = new AccessService({ store });
  });
  beforeEach(async () => {
    schedulerBoundary.started = [];
    cookieBoundary.token = '';
    await prisma.query.deleteMany();
    await prisma.hotelTracker.deleteMany();
    await prisma.carTracker.deleteMany();
    await prisma.sidedoorState.deleteMany();
    await prisma.user.deleteMany();
    await prisma.extractionConfig.deleteMany();
    await prisma.extractionConfig.create({ data: { id: 'singleton', setupComplete: true } });
    await store.initialize();
  });
  afterAll(async () => { await prisma?.$disconnect(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('starts schedulers only after canonical access initialization', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('@/instrumentation');
    await prisma.sidedoorState.deleteMany();
    await expect(register()).rejects.toThrow('initialization is required');
    expect(schedulerBoundary.started).toEqual([]);
    expect(await prisma.sidedoorState.count()).toBe(0);
    await store.initialize();
    await register();
    expect(schedulerBoundary.started).toEqual(['cron', 'travel']);
  });

  it('rejects an unsupported credential vault without repairing it', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('@/instrumentation');
    await initializeProviderCredentials();
    await register();
    expect(schedulerBoundary.started).toEqual(['cron', 'travel']);
    schedulerBoundary.started = [];
    await prisma.sidedoorState.create({ data: { id: 'provider-credentials', revision: 'invalid-fixture', state: { version: 999, imports: [], providers: [] } } });
    const before = await prisma.sidedoorState.findMany();
    await expect(register()).rejects.toThrow();
    expect(schedulerBoundary.started).toEqual([]);
    expect(await prisma.sidedoorState.findMany()).toEqual(before);
  });

  it('refuses runtime access before explicit initialization without creating accounts', async () => {
    await prisma.sidedoorState.delete({ where: { id: 'access' } });
    await expect(store.read()).rejects.toThrow('initialization is required');
    await expect(store.admissionPolicy()).rejects.toThrow('initialization is required');
    await expect(service.issueOperatorToken()).rejects.toThrow('initialization is required');
    expect(await prisma.sidedoorState.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await store.initialize();
    expect((await store.read()).principals).toEqual([]);
  });

  it('rolls back credentials and selection together after an invalid endpoint change', async () => {
    await initializeProviderCredentials();
    vi.stubEnv('OPENAI_BASE_URL', undefined);
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'household');
    const { saveProviderConfiguration } = await import('../providers/provider-config');
    const { resolveProviderCredentials } = await import('../providers/provider-credentials');
    const before = await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } });
    const saved = await saveProviderConfiguration(owner, { data: { provider: 'openai', model: 'gpt-4.1-mini' }, fields: { apiKey: 'original-provider-key' }, expectedUpdatedAt: before.updatedAt });
    await expect(saveProviderConfiguration(owner, { data: { provider: 'openai', model: 'different-model' }, fields: { apiKey: 'must-not-persist', baseUrl: 'https://unconfigured.example/v1' }, expectedUpdatedAt: saved.config.updatedAt })).rejects.toThrow('credentials');
    expect(await resolveProviderCredentials('openai')).toEqual({
      apiKey: 'original-provider-key',
    });
    expect(await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).toMatchObject({ model: 'gpt-4.1-mini', customBaseUrl: null, updatedAt: saved.config.updatedAt });
  });

  it('accepts only one provider save for a configuration revision', async () => {
    await initializeProviderCredentials();
    vi.stubEnv('OPENAI_BASE_URL', undefined);
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'household');
    const { saveProviderConfiguration } = await import('../providers/provider-config');
    const expectedUpdatedAt = (await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).updatedAt;
    const outcomes = await Promise.allSettled(['first-provider-key', 'second-provider-key'].map(apiKey => saveProviderConfiguration(owner, { data: { provider: 'openai', model: 'gpt-4.1-mini' }, fields: { apiKey }, expectedUpdatedAt })));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { message: expect.stringContaining('Configuration changed') } });
  });

  it('preserves deleted members hotel and car history while removing their notification destinations', async () => {
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    const management = new PrincipalManagement(service);
    const member = await store.managePrincipal(owner, await management.prepare({ kind: 'create', name: 'member', password: 'member account password' }));
    const userId = member!.id;
    const hotel = await prisma.hotelTracker.create({ data: { userId, hotelName: 'Saved hotel', search: {}, selection: {}, options: {} } });
    const hotelRun = await prisma.hotelSearchRun.create({ data: { userId, trackerId: hotel.id, request: {}, result: { saved: true } } });
    const car = await prisma.carTracker.create({ data: { userId, label: 'Saved car', search: {}, currency: 'USD' } });
    const carRun = await prisma.carSearchRun.create({ data: { userId, trackerId: car.id, request: {}, result: { saved: true } } });
    await prisma.notificationChannel.create({ data: { userId, type: 'ntfy', config: { topic: 'private-topic' } } });
    await store.managePrincipal(owner, await management.prepare({ kind: 'delete', id: userId }));
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.hotelTracker.findUniqueOrThrow({ where: { id: hotel.id } })).toMatchObject({ userId: null, hotelName: 'Saved hotel' });
    expect(await prisma.hotelSearchRun.findUniqueOrThrow({ where: { id: hotelRun.id } })).toMatchObject({ userId: null, result: { saved: true } });
    expect(await prisma.carTracker.findUniqueOrThrow({ where: { id: car.id } })).toMatchObject({ userId: null, label: 'Saved car' });
    expect(await prisma.carSearchRun.findUniqueOrThrow({ where: { id: carRun.id } })).toMatchObject({ userId: null, result: { saved: true } });
    expect(await prisma.notificationChannel.count({ where: { userId } })).toBe(0);
  });

  it('validates account creation and preserves household guest support without passwordless owners', async () => {
    vi.stubEnv('SELF_HOSTED', 'true');
    cookieBoundary.token = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'household');
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: true } });
    const { POST } = await import('@/app/api/admin/users/route');
    const request = (body: unknown, origin = 'http://localhost:3003') => new NextRequest('http://localhost:3003/api/admin/users', { method: 'POST', headers: { origin, cookie: `ft-session=${cookieBoundary.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const body of [{ username: 'a' }, { username: 'short', password: 'short' }, { username: 'boss', isAdmin: true }, { username: 'wrong', isAdmin: 'yes' }]) expect((await POST(request(body))).status).toBe(400);
    expect((await POST(request({ username: 'forbidden' }, 'https://attacker.example'))).status).toBe(403);
    expect(await prisma.user.count()).toBe(1);
    expect((await POST(request({ username: 'guest', avatar: 'globe' }))).status).toBe(201);
    expect(await prisma.user.findUniqueOrThrow({ where: { username: 'guest' } })).toMatchObject({ isAdmin: false, avatar: 'globe' });
    expect((await POST(request({ username: 'GUEST' }))).status).toBe(409);
    expect((await POST(request({ username: 'other', avatar: 'bogus' }))).status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { username: 'other' } })).avatar).toBeNull();
  });

  it('rejects unsupported updates, self-removal and missing targets without changing accounts', async () => {
    vi.stubEnv('SELF_HOSTED', 'true');
    cookieBoundary.token = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    const ownerId = (await service.authenticate(cookieBoundary.token)).principal!.id;
    const { PATCH, DELETE } = await import('@/app/api/admin/users/[id]/route');
    const request = (method: string, body?: unknown) => new NextRequest('http://localhost:3003/api/admin/users', { method, headers: { origin: 'http://localhost:3003', cookie: `ft-session=${cookieBoundary.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const params = { params: Promise.resolve({ id: ownerId }) };
    expect((await PATCH(request('PATCH', { unknown: true }), params)).status).toBe(400);
    expect((await PATCH(request('PATCH', { password: 'short' }), params)).status).toBe(400);
    expect((await PATCH(request('PATCH', { isAdmin: false }), params)).status).toBe(403);
    expect((await DELETE(request('DELETE'), params)).status).toBe(403);
    expect((await DELETE(request('DELETE'), { params: Promise.resolve({ id: 'missing' }) })).status).toBe(404);
    expect(await prisma.user.count()).toBe(1);
    expect((await service.authenticate(cookieBoundary.token)).principal?.role).toBe('owner');
  });

  it('commits account credentials and metadata together through the actual admin routes', async () => {
    vi.stubEnv('SELF_HOSTED', 'true');
    cookieBoundary.token = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    const { POST } = await import('@/app/api/admin/users/route');
    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const request = (method: string, body: unknown) => new NextRequest('http://localhost:3003/api/admin/users', { method, headers: { origin: 'http://localhost:3003', cookie: `ft-session=${cookieBoundary.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const created = await POST(request('POST', { username: 'member', password: 'member account password', displayName: 'Member display' }));
    expect(created.status).toBe(201);
    const user = (await created.json()).data.user;
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ username: 'member', displayName: 'Member display', isAdmin: false });
    const memberSession = await service.login('member', 'member account password');
    expect((await PATCH(request('PATCH', { displayName: 'Updated display', password: '' }), { params: Promise.resolve({ id: user.id }) })).status).toBe(200);
    expect((await service.authenticate(memberSession)).principal?.id).toBe(user.id);
    expect((await PATCH(request('PATCH', { password: 'replacement account password', isAdmin: true }), { params: Promise.resolve({ id: user.id }) })).status).toBe(200);
    await expect(service.authenticate(memberSession)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await service.authenticate(await service.login('member', 'replacement account password'))).principal?.role).toBe('owner');
  });

  it('serializes competing owner deletions and preserves the surviving account', async () => {
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    const management = new PrincipalManagement(service);
    const firstId = (await service.authenticate(owner)).principal!.id;
    const second = await store.managePrincipal(owner, await management.prepare({ kind: 'create', name: 'second', password: 'second owner password', role: 'owner' }));
    const secondToken = await service.login('second', 'second owner password');
    const removeFirst = await management.prepare({ kind: 'delete', id: firstId });
    const removeSecond = await management.prepare({ kind: 'delete', id: second!.id });
    const outcomes = await Promise.allSettled([store.managePrincipal(owner, removeSecond), store.managePrincipal(secondToken, removeFirst)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { isAdmin: true } })).toBe(1);
    expect((await store.read()).principals.filter(principal => principal.role === 'owner')).toHaveLength(1);
  });

  it('rejects a prepared account change after its authorizing owner session is revoked', async () => {
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    const prepared = await new PrincipalManagement(service).prepare({ kind: 'create', name: 'member', password: 'member account password' });
    await service.logout(owner);
    await expect(store.managePrincipal(owner, prepared, { displayName: 'Must not persist' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await prisma.user.findUnique({ where: { username: 'member' } })).toBeNull();
    expect((await store.read()).principals.map(principal => principal.name)).toEqual(['owner']);
  });

  it('atomically enables individual scoping and disables profiles without clearing setup or owner credentials', async () => {
    const tracker = await prisma.query.create({ data: { rawInput: 'existing', origin: 'ORD', originName: 'Chicago', destination: 'LAX', destinationName: 'Los Angeles', dateFrom: new Date('2027-01-01'), dateTo: new Date('2027-01-02'), expiresAt: new Date('2027-01-03') } });
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    expect((await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).multiUserMode).toBe(true);
    expect((await prisma.query.findUniqueOrThrow({ where: { id: tracker.id } })).userId).toBeNull();
    vi.stubEnv('SELF_HOSTED', 'true');
    cookieBoundary.token = owner;
    const { DELETE } = await import('@/app/api/admin/multi-user/route');
    expect((await DELETE()).status).toBe(200);
    expect((await store.read()).mode).toBe('household');
    expect(await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).toMatchObject({ multiUserMode: false, setupComplete: true });
    const session = await service.login('owner', 'owner account password');
    expect((await service.authenticate(session, true)).principal?.name).toBe('owner');
    expect((await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).multiUserMode).toBe(false);
    expect((await prisma.query.findUniqueOrThrow({ where: { id: tracker.id } })).userId).toBeNull();
  });

  it('rejects a member disabling profiles without changing either access mode', async () => {
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'individual');
    await service.addMember(owner, 'member', 'member account password');
    const member = await service.login('member', 'member account password');
    await expect(store.disableProfiles(member)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await store.read()).mode).toBe('individual');
    expect((await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).multiUserMode).toBe(true);
  });

  it('reads admission policy without weakening managed gates or retaining deleted owners', async () => {
    expect(await store.admissionPolicy()).toEqual({ mode: 'household', hasOwner: false, passwordRequired: false });
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'household');
    const ownerId = (await service.authenticate(owner, true)).principal!.id;
    await service.configureHousehold(owner, 'managed household password');
    expect(await store.admissionPolicy()).toEqual({ mode: 'household', hasOwner: true, passwordRequired: true });
    await service.setMode(owner, 'individual');
    expect((await store.admissionPolicy()).mode).toBe('individual');
    await prisma.user.delete({ where: { id: ownerId } });
    expect((await store.admissionPolicy()).hasOwner).toBe(false);
  });

  it('claims a solo owner once without enabling multiuser mode or reassigning existing trackers', async () => {
    const tracker = await prisma.query.create({ data: { rawInput: 'existing', origin: 'ORD', originName: 'Chicago', destination: 'LAX', destinationName: 'Los Angeles', dateFrom: new Date('2027-01-01'), dateTo: new Date('2027-01-02'), expiresAt: new Date('2027-01-03') } });
    expect((await store.read()).principals).toEqual([]);
    const code = await service.issueOperatorToken();
    const results = await Promise.allSettled([
      service.claimOwner(code, 'owner-one', 'first owner password', 'household'),
      service.claimOwner(code, 'owner-two', 'second owner password', 'household'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { isAdmin: true } })).toBe(1);
    expect((await prisma.query.findUniqueOrThrow({ where: { id: tracker.id } })).userId).toBeNull();
    expect((await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).multiUserMode).toBe(false);
  });

  it('rolls back profile and access changes together when a profile constraint rejects the write', async () => {
    const owner = await service.claimOwner(await service.issueOperatorToken(), 'owner', 'owner account password', 'household');
    await service.addMember(owner, 'member', 'member account password');
    const before = await store.read();
    await expect(store.transact(state => { state.principals.find(principal => principal.name === 'member')!.name = 'owner'; })).rejects.toThrow();
    expect(await store.read()).toEqual(before);
    expect((await prisma.user.findMany({ orderBy: { username: 'asc' } })).map(user => user.username)).toEqual(['member', 'owner']);
  });
});
