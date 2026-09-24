import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, token: '', multiUser: false, user: null as { id: string; isAdmin: boolean } | null }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  user: { findUnique: async () => boundary.user },
  extractionConfig: { findUnique: async () => ({ multiUserMode: boundary.multiUser }) },
} }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { authorizeMutation, canManageQueryWithoutToken } from './query-auth';
beforeEach(() => { boundary.fixture!.reset(); boundary.token = ''; boundary.user = null; boundary.multiUser = false; });
afterEach(() => vi.unstubAllEnvs());
describe('tracker mutation authority', () => {
  it.each(['true', 'false'])('requires owner authority or a matching capability in solo deployments with SELF_HOSTED=%s', async selfHosted => {
    vi.stubEnv('SELF_HOSTED', selfHosted);
    const query = { userId: null, deleteToken: 'tracker-capability' };
    expect(await canManageQueryWithoutToken(query)).toBe(false);
    expect((await authorizeMutation(query, undefined)).status).toBe(401);
    expect((await authorizeMutation(query, 'wrong')).status).toBe(403);
    expect((await authorizeMutation(query, 'tracker-capability')).ok).toBe(true);
    boundary.user = { id: 'owner', isAdmin: true };
    boundary.token = await boundary.fixture!.issue('owner', true);
    expect(await canManageQueryWithoutToken(query)).toBe(true);
    expect((await authorizeMutation(query, undefined)).ok).toBe(true);
    await boundary.fixture!.access.logout(boundary.token);
    expect((await authorizeMutation(query, undefined)).ok).toBe(false);
    expect((await authorizeMutation(query, 'tracker-capability')).ok).toBe(true);
  });
  it('limits a selected household profile to its own trackers', async () => {
    vi.stubEnv('SELF_HOSTED', 'true'); boundary.multiUser = true;
    const fixture = boundary.fixture!;
    const owner = await fixture.issue('owner', true); await fixture.issue('member');
    await fixture.access.configureHousehold(owner, 'household test password');
    boundary.user = { id: 'member', isAdmin: false };
    boundary.token = await fixture.access.enterHousehold('household test password');
    await fixture.profiles.select(boundary.token, 'member');
    for (const userId of ['member', 'someone-else', null]) {
      const query = { userId, deleteToken: 'capability' };
      expect(await canManageQueryWithoutToken(query)).toBe(userId === 'member');
      expect((await authorizeMutation(query, undefined)).ok).toBe(userId === 'member');
    }
  });
});
