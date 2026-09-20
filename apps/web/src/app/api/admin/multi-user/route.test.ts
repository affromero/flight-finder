import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { createRequestAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({
  fixture: null as ReturnType<typeof createRequestAccessFixture> | null,
  enabled: false,
  rows: {} as Record<string, { userId: string | null; isSeed?: boolean }[]>,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.fixture?.token ? { value: boundary.fixture.token } : undefined }) }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createRequestAccessFixture } = await import('@/test/access-fixture');
  const fixture = createRequestAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('@/lib/prisma', () => {
  const table = (name: string) => ({ updateMany: async ({ where, data }: { where: { isSeed?: boolean }; data: { userId: string } }) => {
    const rows = boundary.rows[name]!.filter(row => row.userId === null && (where.isSeed === undefined || row.isSeed === where.isSeed));
    for (const row of rows) row.userId = data.userId;
    return { count: rows.length };
  } });
  const database = {
    user: { findUnique: async () => boundary.fixture!.user },
    extractionConfig: {
      findUnique: async () => ({ multiUserMode: boundary.enabled }),
      upsert: async () => ({}),
      updateMany: async () => { if (boundary.enabled) return { count: 0 }; boundary.enabled = true; return { count: 1 }; },
    },
    query: table('query'), hotelTracker: table('hotelTracker'), hotelSearchRun: table('hotelSearchRun'),
    carTracker: table('carTracker'), carSearchRun: table('carSearchRun'),
  };
  return { prisma: { ...database, $transaction: async (operation: (tx: typeof database) => Promise<unknown>) => operation(database) } };
});
import { POST } from './route';
const request = (body: unknown = {}) => new Request('http://localhost:3003/api/admin/multi-user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(async () => {
  vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('REDIS_URL', '');
  boundary.fixture!.resetRequest(); boundary.enabled = false;
  await boundary.fixture!.signIn({ id: 'owner', username: 'Owner', isAdmin: true });
  boundary.rows = Object.fromEntries(['query', 'hotelTracker', 'hotelSearchRun', 'carTracker', 'carSearchRun'].map(name => [name, [{ userId: null, isSeed: false }, { userId: 'another-member', isSeed: false }]]));
  boundary.rows.query!.push({ userId: null, isSeed: true });
});
afterEach(() => vi.unstubAllEnvs());
it('reuses the claimed owner and preserves already-owned and seeded content', async () => {
  const result = await POST(request());
  expect(result.status).toBe(201);
  expect(await result.json()).toMatchObject({ data: { user: { id: 'owner', isAdmin: true }, backfillCount: 1 } });
  expect(boundary.enabled).toBe(true);
  for (const rows of Object.values(boundary.rows)) expect(rows.slice(0, 2).map(row => row.userId)).toEqual(['owner', 'another-member']);
  expect(boundary.rows.query![2]!.userId).toBeNull();
});
it('rejects anonymous and member callers before enabling profiles', async () => {
  await boundary.fixture!.signIn(null);
  expect((await POST(request())).status).toBe(401);
  await boundary.fixture!.signIn({ id: 'member', isAdmin: false });
  expect((await POST(request())).status).toBe(403);
  expect(boundary.enabled).toBe(false);
  expect(boundary.rows.query![0]!.userId).toBeNull();
});
it('rejects duplicate owner credentials rather than silently discarding them', async () => {
  expect((await POST(request({ adminUsername: 'another-owner', adminPassword: 'another password' }))).status).toBe(400);
  expect(boundary.enabled).toBe(false);
});
it('allows only one concurrent enable transition', async () => {
  const results = await Promise.all([POST(request()), POST(request())]);
  expect(results.map(result => result.status).sort()).toEqual([201, 409]);
});
