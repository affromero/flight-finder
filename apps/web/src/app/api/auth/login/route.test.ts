import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';

const boundary = vi.hoisted(() => ({
  fixture: null as ReturnType<typeof createAccessFixture> | null,
  token: '', multiUser: true, lookups: 0,
  users: [] as { id: string; username: string; displayName: string | null }[],
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  extractionConfig: { findUnique: async () => ({ publicBaseUrl: 'http://localhost:3003', multiUserMode: boundary.multiUser }) },
  user: { findUnique: async ({ where }: { where: { username: string } }) => {
    boundary.lookups++;
    return boundary.users.find(user => user.username === where.username) ?? null;
  } },
} }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { POST } from './route';

const request = (body: unknown, origin = 'http://localhost:3003') => new Request('http://localhost:3003/api/auth/login', {
  method: 'POST', headers: { origin, host: 'localhost:3003', 'content-type': 'application/json', cookie: boundary.token ? `ft-session=${boundary.token}` : '' },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('REDIS_URL', '');
  boundary.fixture!.reset(); boundary.token = ''; boundary.multiUser = true; boundary.lookups = 0;
  const access = boundary.fixture!.access;
  await access.claimOwner(await access.issueOperatorToken(), 'Owner', 'owner password for testing', 'household');
  await access.store.transact(state => { state.principals.push({ id: 'member', name: 'Member', role: 'member', passwordHash: null, epoch: 0, createdAt: Date.now() }); });
  boundary.users = (await access.store.read()).principals.map(principal => ({ id: principal.id, username: principal.name, displayName: null }));
});
afterEach(() => vi.unstubAllEnvs());

describe('profile login through shared access', () => {
  it('rejects untrusted origins before looking up accounts or allocating access state', async () => {
    const before = await boundary.fixture!.access.store.read();
    for (const username of ['Member', 'missing']) expect((await POST(request({ username }, 'https://attacker.example'))).status).toBe(403);
    expect(boundary.lookups).toBe(0);
    expect(await boundary.fixture!.access.store.read()).toEqual(before);
  });
  it('admits a household profile without granting an authenticated identity', async () => {
    const response = await POST(request({ username: 'Member' }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.user).toMatchObject({ id: 'member', isAdmin: false });
    const token = response.headers.get('set-cookie')!.split(';')[0]!.slice('ft-session='.length);
    expect((await boundary.fixture!.access.authenticate(token)).principal).toBeNull();
    expect(await boundary.fixture!.profiles.selected(token)).toMatchObject({ id: 'member' });
  });
  it('preserves password login and effective owner authority', async () => {
    const response = await POST(request({ username: 'Owner', password: 'owner password for testing' }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.user).toMatchObject({ username: 'Owner', isAdmin: true });
  });
  it('bounds unknown-account attempts', async () => {
    for (let index = 0; index < 10; index++) expect((await POST(request({ username: 'missing', password: 'wrong' }))).status).toBe(401);
    expect((await POST(request({ username: 'missing', password: 'wrong' }))).status).toBe(429);
  });
  it('requires explicit sign-out before switching an account to a household profile', async () => {
    boundary.token = await boundary.fixture!.access.login('Owner', 'owner password for testing');
    expect((await POST(request({ username: 'Member' }))).status).toBe(403);
    expect((await boundary.fixture!.access.authenticate(boundary.token)).principal?.role).toBe('owner');
  });
});
