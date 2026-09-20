import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';

const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, multiUser: true, token: '', user: null as { id: string; isAdmin: boolean } | null }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture();
  boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { carActor } from './access';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findUnique: async () => ({ multiUserMode: boundary.multiUser }) }, user: { findUnique: async ({ where }: { where: { id: string } }) => boundary.user?.id === where.id ? boundary.user : null } } }));

describe('car access through actual session verification', () => {
  beforeEach(() => {
    boundary.fixture!.reset();
    vi.stubEnv('SELF_HOSTED', 'true');
    vi.stubEnv('REDIS_URL', '');
    boundary.multiUser = true; boundary.token = ''; boundary.user = null;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('keeps car operations unavailable on the public instance even with a valid administrator session', async () => {
    vi.stubEnv('SELF_HOSTED', 'false');
    boundary.user = { id: 'admin', isAdmin: true };
    boundary.token = await boundary.fixture!.issue('admin', true);
    const { carActor } = await import('./access');
    await expect(carActor()).rejects.toMatchObject({ status: 404 });
  });
  it('requires an authenticated owner in solo mode while preserving unowned tracker access', async () => {
    boundary.multiUser = false;
    await expect(carActor()).rejects.toMatchObject({ status: 401 });
    boundary.user = { id: 'admin', isAdmin: true };
    boundary.token = await boundary.fixture!.issue('admin', true);
    expect(await carActor()).toEqual({ userId: null, isAdmin: true });
  });
  it('requires a valid current user in multi-user mode', async () => {
    const { carActor } = await import('./access');
    await expect(carActor()).rejects.toMatchObject({ status: 401 });
    boundary.user = { id: 'user', isAdmin: false };
    boundary.token = await boundary.fixture!.issue('user');
    expect(await carActor()).toEqual({ userId: 'user', isAdmin: false });
    boundary.token = boundary.token.slice(0, -1) + (boundary.token.endsWith('a') ? 'b' : 'a');
    await expect(carActor()).rejects.toMatchObject({ status: 401 });
  });
  it('rejects deleted users and revoked sessions instead of trusting a previously signed token', async () => {
    const { carActor } = await import('./access');
    boundary.token = await boundary.fixture!.issue('deleted');
    await expect(carActor()).rejects.toMatchObject({ status: 401 });
    boundary.user = { id: 'deleted', isAdmin: true };
    await boundary.fixture!.access.store.transact(state => { state.principals[0]!.epoch++; });
    await expect(carActor()).rejects.toMatchObject({ status: 401 });
  });
});
