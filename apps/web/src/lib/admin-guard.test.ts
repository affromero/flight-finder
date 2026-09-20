import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, token: '', user: null as { id: string; isAdmin: boolean } | null }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: async () => boundary.user } } }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { requireAdminApi, verifyAdminSessionRevocable } from './admin-guard';
beforeEach(() => { boundary.fixture!.reset(); boundary.token = ''; boundary.user = null; });
afterEach(() => vi.unstubAllEnvs());
describe('shared owner guards', () => {
  it.each(['true', 'false'])('requires persisted owner authority with SELF_HOSTED=%s', async selfHosted => {
    vi.stubEnv('SELF_HOSTED', selfHosted);
    expect((await requireAdminApi())?.status).toBe(401);
    boundary.user = { id: 'member', isAdmin: true };
    boundary.token = await boundary.fixture!.issue('member');
    expect((await requireAdminApi())?.status).toBe(403);
    expect(await verifyAdminSessionRevocable()).toBe(false);
    boundary.user = { id: 'owner', isAdmin: true };
    boundary.token = await boundary.fixture!.issue('owner', true);
    expect(await requireAdminApi()).toBeNull();
    expect(await verifyAdminSessionRevocable()).toBe(true);
    await boundary.fixture!.access.logout(boundary.token);
    expect((await requireAdminApi())?.status).toBe(401);
  });
  it('rejects non-Sidedoor signatures and deleted owners', async () => {
    boundary.token = 'admin:1700000000000.signature';
    expect(await verifyAdminSessionRevocable()).toBe(false);
    boundary.token = await boundary.fixture!.issue('owner', true);
    expect((await requireAdminApi())?.status).toBe(401);
  });
});
