import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';
const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, owner: '', publicBaseUrl: 'http://localhost:3003' }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findUnique: async () => ({ publicBaseUrl: boundary.publicBaseUrl }) } } }));
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture(); boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { POST as issue } from '@/app/api/admin/access-invitation/route';
import { GET as accessGet, POST as redeem } from '@/app/api/access/[action]/route';
const request = (path: string, body: unknown, token = '', origin = 'http://localhost:3003') => new Request(`http://localhost:3003${path}`, {
  method: 'POST', headers: { host: 'localhost:3003', origin, 'content-type': 'application/json', cookie: `ft-session=${token}` }, body: JSON.stringify(body),
});
const redeemCode = (code: string, enrollment?: { name: string; password: string }) => redeem(request('/api/access/redeem-invitation', { code, enrollment }), { params: Promise.resolve({ action: 'redeem-invitation' }) });
beforeEach(async () => {
  boundary.fixture!.reset();
  boundary.publicBaseUrl = 'http://localhost:3003';
  boundary.owner = await boundary.fixture!.issue('owner', true);
  await boundary.fixture!.access.configureHousehold(boundary.owner, 'original household password');
  boundary.owner = await boundary.fixture!.access.enterHousehold('original household password');
  await boundary.fixture!.profiles.select(boundary.owner, 'owner');
});
afterEach(() => vi.unstubAllEnvs());
it('keeps hosted account invitations single-use without exposing their code in the URL', async () => {
  vi.stubEnv('SELF_HOSTED', 'false');
  await boundary.fixture!.access.setMode(boundary.owner, 'individual');
  boundary.owner = await boundary.fixture!.issue('owner', true);
  const result = await issue(request('/api/admin/access-invitation', {}, boundary.owner));
  expect(result.status).toBe(200);
  const url = new URL((await result.json()).data.url);
  expect(url.searchParams.get('mode')).toBe('invite');
  const code = new URLSearchParams(url.hash.slice(1)).get('invite')!;
  const enrollment = { name: 'friend', password: 'a sufficiently long password' };
  const responses = await Promise.all([redeemCode(code, enrollment), redeemCode(code, enrollment)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
  const token = responses.find(response => response.ok)!.headers.get('set-cookie')!.split(';')[0]!.slice('ft-session='.length);
  expect((await boundary.fixture!.access.authenticate(token)).principal?.role).toBe('member');
});
it('rejects private household invitation issuance and cross-origin requests', async () => {
  vi.stubEnv('SELF_HOSTED', 'true');
  const guest = await boundary.fixture!.access.enterHousehold('original household password');
  expect((await issue(request('/api/admin/access-invitation', {}, guest))).status).toBe(403);
  expect((await issue(request('/api/admin/access-invitation', {}, boundary.owner))).status).toBe(403);
  expect((await issue(request('/api/admin/access-invitation', {}, boundary.owner, 'https://attacker.example'))).status).toBe(403);
  expect((await boundary.fixture!.access.store.read()).invitations).toEqual([]);
});
it('offers passkeys through the configured HTTPS reverse proxy origin', async () => {
  boundary.publicBaseUrl = 'https://finder.example';
  const response = await accessGet(new Request('http://web:3003/api/access/capabilities', {
    headers: { host: 'web:3003', 'x-sidedoor-origin': 'https://finder.example' },
  }), { params: Promise.resolve({ action: 'capabilities' }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ password: true, passkeys: true });
});
