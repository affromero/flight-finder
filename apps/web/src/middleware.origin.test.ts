import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/sidedoor/access/service', () => ({
  sharedAccess: { authenticate: vi.fn() },
  sharedAccessStore: {
    admissionPolicy: vi.fn().mockResolvedValue({
      mode: 'household',
      hasOwner: true,
      passwordRequired: false,
    }),
  },
  SHARED_SESSION_COOKIE: 'ft-session',
}));

beforeEach(() => { vi.resetModules(); vi.stubEnv('SELF_HOSTED', 'true'); vi.stubEnv('FF_ACCESS_PASSWORD', ''); });
afterEach(() => vi.unstubAllEnvs());

async function submit(headers: Record<string, string>, method = 'POST') {
  const { middleware } = await import('./middleware');
  return middleware(new NextRequest('https://finder.example/api/queries', { method, headers }));
}

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects cross-origin %s before solo administrator access', async method => {
  const response = await submit({ origin: 'https://attacker.example', 'content-type': 'text/plain' }, method);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ ok: false });
});
it('rejects sandboxed null origins and cross-site requests without an origin', async () => {
  expect((await submit({ origin: 'null' })).status).toBe(403);
  expect((await submit({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
});
it('allows same-origin browser mutations and nonbrowser API clients', async () => {
  expect((await submit({ origin: 'https://finder.example', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  expect((await submit({ 'content-type': 'application/json' })).status).toBe(200);
});
it('keeps read-only cross-origin requests available', async () => {
  expect((await submit({ origin: 'https://attacker.example' }, 'GET')).status).toBe(200);
});
it('allows HTTPS requests through a trusted proxy with an internal listening URL', async () => {
  const { middleware } = await import('./middleware');
  const response = await middleware(new NextRequest('http://0.0.0.0:3003/api/queries', { method: 'PATCH', headers: {
    host: 'finder.example', origin: 'https://finder.example', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin',
  } }));
  expect(response.status).toBe(200);
});
it('does not authorize attacker origins using an untrusted forwarded host', async () => {
  expect((await submit({ host: 'finder.example', origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' })).status).toBe(403);
});
