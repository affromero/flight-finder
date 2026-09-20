import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../prisma';
import { invalidateMultiUserCache } from '../multi-user';
import { createDatabaseSession } from '@/test/database-session';
import { sharedAccess } from '@/lib/sidedoor/access/service';
import { GET as adminGet, PATCH as adminPatch } from '@/app/api/admin/hotel-map/route';
import { PATCH as accountPatch } from '@/app/api/account/settings/route';
import { DEFAULT_HOTEL_MAP_CONFIG } from './map-config';
import { getHotelMapConfig, saveHotelMapConfig } from './map-config-store';

const boundary = vi.hoisted(() => ({ cookie: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: boundary.cookie }) }));

describe.skipIf(process.env.HOTEL_MAP_INTEGRATION_TESTS !== '1')('map settings against isolated PostgreSQL and real authorization', () => {
  let alice = '', bob = '';
  let originalMode = false;
  let flightConfig: unknown;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || !['/hotel_map_test', '/hotel_test'].includes(url.pathname)) throw new Error('Requires disposable localhost hotel_map_test or hotel_test database');
    vi.stubEnv('SELF_HOSTED', 'true');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'map-integration-test-secret');
    const config = await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } });
    originalMode = config.multiUserMode;
    alice = (await prisma.user.create({ data: { username: `map-alice-${crypto.randomUUID()}`, isAdmin: true } })).id;
    bob = (await prisma.user.create({ data: { username: `map-bob-${crypto.randomUUID()}` } })).id;
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: true } });
    await invalidateMultiUserCache();
    flightConfig = await prisma.extractionConfig.findUniqueOrThrow({ where: { id: 'singleton' } });
  });
  beforeEach(() => { boundary.cookie.mockReset(); });
  afterAll(async () => {
    if (!alice) return;
    await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { multiUserMode: originalMode } });
    await invalidateMultiUserCache();
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });
  async function signIn(id: string) { boundary.cookie.mockReturnValue({ value: await createDatabaseSession(id) }); }
  function submission(path: string, actor: string, body: unknown) {
    return new NextRequest(`http://localhost${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Hotel-Map-Actor': `user:${actor}` }, body: JSON.stringify(body) });
  }
  it('allows exactly one concurrent revision update and leaves all flight configuration unchanged', async () => {
    const initial = await getHotelMapConfig();
    const candidates = [false, true].map(enabled => saveHotelMapConfig({ ...initial.config, enabled }, initial.revision));
    const settled = await Promise.allSettled(candidates);
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = settled.find(result => result.status === 'rejected');
    expect(rejection).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const saved = await getHotelMapConfig();
    expect(saved.revision).toBe(initial.revision + 1);
    expect(await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } })).toEqual(flightConfig);
    await saveHotelMapConfig(initial.config, saved.revision);
  });
  it('rejects non-admin and revoked administrator sessions before changing provider settings', async () => {
    const initial = await getHotelMapConfig();
    await signIn(bob);
    expect((await adminGet()).status).toBe(403);
    expect((await adminPatch(submission('/api/admin/hotel-map', bob, { config: DEFAULT_HOTEL_MAP_CONFIG, revision: initial.revision }))).status).toBe(403);
    await signIn(alice);
    await sharedAccess.store.transact(state => { state.principals.find(principal => principal.id === alice)!.epoch++; });
    expect((await adminGet()).status).toBe(401);
    expect(await getHotelMapConfig()).toEqual(initial);
  });
  it('rejects another account’s stale form and stores preferences only on the authenticated account', async () => {
    await signIn(bob);
    const preferences = { version: 1, style: 'bright', enabled: false };
    expect((await accountPatch(submission('/api/account/settings', alice, { hotelMapPreferences: preferences }))).status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: bob } })).hotelMapPreferences).toBeNull();
    expect((await accountPatch(submission('/api/account/settings', bob, { hotelMapPreferences: preferences, hotelMapPreferencesRevision: 0 }))).status).toBe(200);
    expect((await accountPatch(submission('/api/account/settings', bob, { hotelMapPreferences: { ...preferences, enabled: true }, hotelMapPreferencesRevision: 0 }))).status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: bob } })).hotelMapPreferences).toEqual(preferences);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alice } })).hotelMapPreferences).toBeNull();
    expect(await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } })).toEqual(flightConfig);
  });
});
