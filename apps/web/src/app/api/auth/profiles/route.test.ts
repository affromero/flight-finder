import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, token: '', owner: '', multiUser: true }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  extractionConfig: { findUnique: async () => ({ multiUserMode: boundary.multiUser }) },
  user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
    const state = await boundary.fixture!.access.store.read();
    return state.principals.filter(principal => where.id.in.includes(principal.id)).map(principal => ({ id: principal.id, username: principal.name, displayName: null, avatar: 'globe' }));
  } },
} }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { GET } from './route';
beforeEach(async () => {
  vi.stubEnv('SELF_HOSTED', 'true'); boundary.multiUser = true; boundary.token = '';
  boundary.fixture!.reset();
  boundary.owner = await boundary.fixture!.issue('owner', true);
  await boundary.fixture!.issue('member');
  await boundary.fixture!.access.store.transact(state => { state.principals[0]!.passwordHash = 'private-hash'; });
});
afterEach(() => vi.unstubAllEnvs());
it('preserves profile names and avatars in an explicitly open household without exposing hashes', async () => {
  const result = await GET();
  expect(result.status).toBe(200);
  const payload = await result.json();
  expect(payload.data.profiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ username: 'owner', avatar: 'globe', hasPassword: true }),
    expect.objectContaining({ username: 'member', hasPassword: false }),
  ]));
  expect(JSON.stringify(payload)).not.toMatch(/private-hash|passwordHash/);
});
it('requires household admission and hides account names entirely in individual mode', async () => {
  await boundary.fixture!.access.configureHousehold(boundary.owner, 'household password for testing');
  expect((await GET()).status).toBe(401);
  boundary.token = await boundary.fixture!.access.enterHousehold('household password for testing');
  expect((await GET()).status).toBe(200);
  await boundary.fixture!.access.setMode(boundary.owner, 'individual');
  expect((await (await GET()).json()).data.profiles).toEqual([]);
});
it('does not expose profile selection when multiuser mode is disabled', async () => {
  boundary.multiUser = false;
  expect((await GET()).status).toBe(404);
});
