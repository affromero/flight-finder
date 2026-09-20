import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { createRequestAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createRequestAccessFixture> | null, enabled: true }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createRequestAccessFixture } = await import('@/test/access-fixture');
  const fixture = createRequestAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.fixture?.token ? { value: boundary.fixture.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  extractionConfig: { findUnique: async () => ({ multiUserMode: boundary.enabled }) },
  user: { findUnique: async () => boundary.fixture!.user, findMany: async () => [{ id: 'member', username: 'member', isAdmin: false, _count: { queries: 2 } }] },
} }));
import { GET } from './route';

beforeEach(async () => {
  vi.stubEnv('SELF_HOSTED', 'true');
  boundary.enabled = true;
  boundary.fixture!.resetRequest();
  await boundary.fixture!.signIn({ id: 'owner', isAdmin: true });
});
afterEach(() => vi.unstubAllEnvs());
it('returns profile listings only to an authenticated owner while profiles are enabled', async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect((await response.json()).data.users).toEqual([expect.objectContaining({ username: 'member', _count: { queries: 2 } })]);
  boundary.enabled = false;
  expect((await GET()).status).toBe(404);
});
it('rejects missing or non-owner credentials', async () => {
  await boundary.fixture!.signIn(null);
  expect((await GET()).status).toBe(401);
  await boundary.fixture!.signIn({ id: 'member', isAdmin: false });
  expect((await GET()).status).toBe(403);
});
