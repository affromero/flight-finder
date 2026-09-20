import { beforeEach, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, token: '' }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findUnique: async () => ({ publicBaseUrl: 'http://localhost:3003' }) } } }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { POST } from './route';
const request = (currentPassword = 'original owner password', newPassword = 'replacement owner password') => new Request('http://localhost:3003/api/account/password', {
  method: 'POST', headers: { host: 'localhost:3003', origin: 'http://localhost:3003', 'content-type': 'application/json', cookie: `ft-session=${boundary.token}` },
  body: JSON.stringify({ currentPassword, newPassword }),
});
beforeEach(async () => {
  boundary.fixture!.reset();
  const access = boundary.fixture!.access;
  boundary.token = await access.claimOwner(await access.issueOperatorToken(), 'Owner', 'original owner password', 'household');
});
it('changes the actual principal credential and revokes old devices while retaining the successful browser', async () => {
  const access = boundary.fixture!.access;
  const other = await access.login('Owner', 'original owner password');
  const result = await POST(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ data: { changed: true } });
  const updated = result.headers.get('set-cookie')!.split(';')[0]!.slice('ft-session='.length);
  expect((await access.authenticate(updated)).principal?.role).toBe('owner');
  await expect(access.authenticate(other)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(access.authenticate(boundary.token)).rejects.toMatchObject({ code: 'unauthorized' });
  expect((await access.authenticate(await access.login('Owner', 'replacement owner password'))).principal?.role).toBe('owner');
});
it('preserves the current session after rejected password changes', async () => {
  expect((await POST(request('wrong'))).status).toBe(401);
  expect((await POST(request('original owner password', 'short'))).status).toBe(400);
  expect((await boundary.fixture!.access.authenticate(boundary.token)).principal?.role).toBe('owner');
});
it('bounds wrong-current-password attempts', async () => {
  for (let index = 0; index < 10; index++) expect((await POST(request('wrong'))).status).toBe(401);
  expect((await POST(request('wrong'))).status).toBe(429);
});
it('rejects anonymous and household-only callers', async () => {
  boundary.token = '';
  expect((await POST(request())).status).toBe(401);
  boundary.token = await boundary.fixture!.access.enterOpenHousehold();
  expect((await POST(request())).status).toBe(403);
});
