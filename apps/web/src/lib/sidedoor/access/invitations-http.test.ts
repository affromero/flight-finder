import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, owner: '' }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findUnique: async () => ({ publicBaseUrl: 'http://localhost:3003' }) } } }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { POST as issue } from '@/app/api/admin/access-invitation/route';
import { POST as redeem } from '@/app/api/access/[action]/route';
const request = (path: string, body: unknown, token = '', origin = 'http://localhost:3003') => new Request(`http://localhost:3003${path}`, {
  method: 'POST', headers: { host: 'localhost:3003', origin, 'content-type': 'application/json', cookie: `ft-session=${token}` }, body: JSON.stringify(body),
});
const redeemCode = (code: string, enrollment?: { name: string; password: string }) => redeem(request('/api/access/redeem-invitation', { code, enrollment }), { params: Promise.resolve({ action: 'redeem-invitation' }) });
beforeEach(async () => {
  boundary.fixture!.reset();
  boundary.owner = await boundary.fixture!.issue('owner', true);
  await boundary.fixture!.access.configureHousehold(boundary.owner, 'original household password');
});
afterEach(() => vi.unstubAllEnvs());
it('issues fragment-only invitation URLs and permits exactly one concurrent redemption', async () => {
  const result = await issue(request('/api/admin/access-invitation', {}, boundary.owner));
  expect(result.status).toBe(200);
  const url = new URL((await result.json()).data.url);
  expect(url.searchParams.get('mode')).toBe('invite');
  const code = new URLSearchParams(url.hash.slice(1)).get('invite')!;
  const responses = await Promise.all([redeemCode(code), redeemCode(code)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
  const token = responses.find(response => response.ok)!.headers.get('set-cookie')!.split(';')[0]!.slice('ft-session='.length);
  expect((await boundary.fixture!.access.authenticate(token)).principal).toBeNull();
});
it('carries the actual invitation mode into individual account enrollment', async () => {
  await boundary.fixture!.access.setMode(boundary.owner, 'individual');
  const result = await issue(request('/api/admin/access-invitation', {}, boundary.owner));
  const fragment = new URLSearchParams(new URL((await result.json()).data.url).hash.slice(1));
  expect(fragment.get('mode')).toBe('individual');
  const accepted = await redeemCode(fragment.get('invite')!, { name: 'New member', password: 'new member password' });
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).principal).toMatchObject({ name: 'New member', role: 'member' });
});
it('rejects household invitation issuance and cross-origin requests without allocating invitations', async () => {
  const guest = await boundary.fixture!.access.enterHousehold('original household password');
  expect((await issue(request('/api/admin/access-invitation', {}, guest))).status).toBe(403);
  expect((await issue(request('/api/admin/access-invitation', {}, boundary.owner, 'https://attacker.example'))).status).toBe(403);
  expect((await boundary.fixture!.access.store.read()).invitations).toEqual([]);
});
