import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';

const boundary = vi.hoisted(() => ({
  token: '',
  user: null as { id: string; username: string; isAdmin: boolean } | null,
  fixture: null as ReturnType<typeof createAccessFixture> | null,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => name === 'ft-session' && boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: async ({ where }: { where: { id: string } }) => boundary.user?.id === where.id ? boundary.user : null } } }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture();
  boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { getCurrentUser, getCurrentProfile, requireAdminUser } from './user-auth';

beforeEach(() => {
  boundary.fixture!.reset(); boundary.token = '';
  boundary.user = { id: 'member', username: 'member', isAdmin: false };
});
afterEach(() => vi.unstubAllEnvs());

describe('shared account identity', () => {
  it('requires a persisted session and rejects non-Sidedoor or tampered cookie values', async () => {
    expect(await getCurrentUser()).toBeNull();
    boundary.token = 'user:member:1700000000000.invalid-signature';
    expect(await getCurrentUser()).toBeNull();
    boundary.token = await boundary.fixture!.issue('member');
    expect(await getCurrentUser()).toMatchObject({ id: 'member', isAdmin: false });
    boundary.token += 'changed';
    expect(await getCurrentUser()).toBeNull();
  });
  it('uses effective owner authority rather than a dormant database administrator flag', async () => {
    boundary.user!.isAdmin = true;
    boundary.token = await boundary.fixture!.issue('member');
    expect(await getCurrentUser()).toMatchObject({ isAdmin: false });
    await expect(requireAdminUser()).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
  it('rejects deleted accounts and revoked sessions on the next lookup', async () => {
    boundary.token = await boundary.fixture!.issue('member');
    const user = boundary.user;
    boundary.user = null;
    expect(await getCurrentUser()).toBeNull();
    boundary.user = user;
    await boundary.fixture!.access.store.transact(state => { state.principals[0]!.epoch++; });
    expect(await getCurrentUser()).toBeNull();
  });
  it('keeps selected household content separate from authenticated identity', async () => {
    const fixture = boundary.fixture!;
    await fixture.issue('member');
    await fixture.issue('owner', true);
    boundary.token = await fixture.access.enterOpenHousehold();
    await fixture.profiles.select(boundary.token, 'member');
    expect(await getCurrentUser()).toBeNull();
    expect(await getCurrentProfile()).toMatchObject({ id: 'member', isAdmin: false });
    await expect(requireAdminUser()).rejects.toMatchObject({ name: 'UnauthorizedError' });
    await fixture.access.store.transact(state => { state.principals.find(principal => principal.id === 'member')!.passwordHash = 'protected credential'; });
    expect(await getCurrentProfile()).toBeNull();
  });
});
