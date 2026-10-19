import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createAccessFixture } from '@/test/access-fixture';

const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, publicBaseUrl: null as string | null }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findUnique: async () => ({ publicBaseUrl: boundary.publicBaseUrl }) } } }));
// Replace database persistence with the same real services over in-memory storage.
vi.mock('@/lib/sidedoor/access/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture();
  boundary.fixture = fixture;
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, SHARED_SESSION_COOKIE: 'ft-session' };
});
import { GET, POST } from '@/app/api/access/[action]/route';
import { accessOrigin } from './configuration';

const password = 'issue-244-household-password';
const context = (action: string) => ({ params: Promise.resolve({ action }) });
function enter(origin: string, headers: Record<string, string> = {}, input = password, backend = origin) {
  return POST(new Request(`${backend}/api/access/household`, {
    method: 'POST', headers: { host: new URL(backend).host, origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password: input }),
  }), context('household'));
}

beforeEach(async () => {
  vi.stubEnv('APP_URL', 'http://localhost:3003');
  vi.stubEnv('SIDEDOOR_PASSWORD_ORIGINS', '[]');
  boundary.publicBaseUrl = null;
  boundary.fixture!.reset();
  const owner = await boundary.fixture!.issue('owner', true);
  await boundary.fixture!.access.configureHousehold(owner, password);
});
afterEach(() => vi.unstubAllEnvs());

describe('installed address admission', () => {
  it.each(['http://localhost:3003', 'http://localhost:3098', 'http://127.0.0.1:3098', 'http://192.168.1.50:3098', 'http://[::1]:3098'])('issues a reusable session at %s when explicitly configured', async origin => {
    vi.stubEnv('APP_URL', 'http://localhost:3098');
    vi.stubEnv('SIDEDOOR_PASSWORD_ORIGINS', JSON.stringify(['http://localhost:3098', origin, `${origin}/`]));
    const response = await enter(origin);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    const session = await GET(new Request(`${origin}/api/access/session`, { headers: { host: new URL(origin).host, cookie: cookie.split(';')[0]! } }), context('session'));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ principal: null, sessionId: expect.any(String) });
  });

  it('supports a configured HTTPS proxy and HTTP LAN without marking LAN cookies secure', async () => {
    boundary.publicBaseUrl = 'https://finder.example';
    vi.stubEnv('SIDEDOOR_PASSWORD_ORIGINS', '["http://192.168.1.50:3098"]');
    const secure = await enter('https://finder.example', {}, password, 'http://web:3003');
    expect(secure.status).toBe(200);
    expect(secure.headers.get('set-cookie')).toContain('Secure');
    const local = await enter('http://192.168.1.50:3098');
    expect(local.status).toBe(200);
    expect(local.headers.get('set-cookie')).not.toContain('Secure');
    const capabilities = await GET(new Request('http://192.168.1.50:3098/api/access/capabilities'), context('capabilities'));
    expect(await capabilities.json()).toMatchObject({ passkeys: false });
  });

  it('restores reverse-proxy login through APP_URL while keeping other origins blocked', async () => {
    const origin = 'https://flights.example:8443';
    const backend = 'http://web:3003';
    const forwarded = { 'x-forwarded-host': 'flights.example:8443', 'x-forwarded-proto': 'https' };
    const before = (await boundary.fixture!.access.store.read()).sessions;
    const rejected = await enter(origin, forwarded, password, backend);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: 'origin_not_allowed' });
    expect(rejected.headers.has('set-cookie')).toBe(false);
    expect((await boundary.fixture!.access.store.read()).sessions).toEqual(before);

    vi.stubEnv('APP_URL', origin);
    const admitted = await enter(origin, forwarded, password, backend);
    expect(admitted.status).toBe(200);
    const cookie = admitted.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    const session = await GET(new Request(`${backend}/api/access/session`, {
      headers: { host: 'web:3003', origin, ...forwarded, cookie: cookie.split(';')[0]! },
    }), context('session'));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ principal: null, sessionId: expect.any(String) });

    const unknown = await enter('https://unconfigured.example', forwarded, password, backend);
    expect(unknown.status).toBe(403);
    expect(unknown.headers.has('set-cookie')).toBe(false);
  });

  it.each([
    ['unknown LAN', 'http://192.168.1.50:3003', {}],
    ['unknown host', 'https://evil.example', {}],
    ['mismatched browser origin', 'https://evil.example', { host: 'localhost:3003' }],
    ['spoofed forwarding', 'https://evil.example', { 'x-forwarded-host': 'localhost:3003', 'x-forwarded-proto': 'http' }],
    ['spoofed origin hint', 'http://localhost:3003', { 'x-sidedoor-origin': 'https://evil.example' }],
    ['cross-site request', 'http://localhost:3003', { 'sec-fetch-site': 'cross-site' }],
    ['null origin', 'http://localhost:3003', { origin: 'null' }],
    ['empty origin', 'http://localhost:3003', { origin: '' }],
  ].map(([name, origin, headers]) => ({ name, origin, headers })) as { name: string; origin: string; headers: Record<string, string> }[])('rejects $name without creating a session', async ({ origin, headers }) => {
    const before = (await boundary.fixture!.access.store.read()).sessions;
    const response = await enter(origin, headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'origin_not_allowed' });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect((await boundary.fixture!.access.store.read()).sessions).toEqual(before);
  });

  it('rejects a browser POST with no Origin header', async () => {
    const response = await POST(new Request('http://localhost:3003/api/access/household', {
      method: 'POST', headers: { host: 'localhost:3003', 'content-type': 'application/json' }, body: JSON.stringify({ password }),
    }), context('household'));
    expect(response.status).toBe(403);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('keeps incorrect passwords distinct from address configuration failures', async () => {
    const response = await enter('http://localhost:3003', {}, 'incorrect password');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it.each(['', 'null', '{}', '[42]', '["https://*.example"]', '["http://localhost:3003/path"]'])('fails closed for malformed origin configuration %s', async value => {
    vi.stubEnv('SIDEDOOR_PASSWORD_ORIGINS', value);
    const response = await enter('http://localhost:3003');
    expect(response.status).toBe(503);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('uses the persisted canonical address ahead of environment configuration', async () => {
    vi.stubEnv('APP_URL', 'https://environment.example');
    boundary.publicBaseUrl = 'https://configured.example';
    expect((await enter('https://configured.example')).status).toBe(200);
    expect((await enter('https://environment.example')).status).toBe(403);
    expect((await enter('http://localhost:3003')).status).toBe(403);
  });
});

it.each(['ftp://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#fragment', 'https://*.example.com'])('rejects an unsafe canonical address %s', value => {
  expect(() => accessOrigin(value)).toThrow();
});
