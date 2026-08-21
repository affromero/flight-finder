import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const PASSWORD = 'a-long-enough-gate-password';

async function run(path: string, init?: { cookie?: string; auth?: string }) {
  const { middleware } = await import('./middleware');
  const headers = new Headers();
  if (init?.cookie) headers.set('cookie', init.cookie);
  if (init?.auth) headers.set('authorization', init.auth);
  return middleware(new NextRequest(`https://ff.example.com${path}`, { headers }));
}

async function sessionCookie() {
  const { createSessionToken, GATE_COOKIE } = await import('./lib/access/gate');
  return `${GATE_COOKIE}=${await createSessionToken()}`;
}

describe('middleware access gate', () => {
  beforeEach(() => {
    vi.resetModules();
    // Self-hosted keeps the analytics beacon and admin redirects out of the way;
    // the gate is what these tests are about.
    vi.stubEnv('SELF_HOSTED', 'true');
    vi.stubEnv('FF_ACCESS_PASSWORD', PASSWORD);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does nothing at all when no password is configured', async () => {
    vi.stubEnv('FF_ACCESS_PASSWORD', '');
    const res = await run('/');

    // The public deployment must be untouched by any of this.
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('sends an uncredentialed browser to the gate, remembering where it was going', async () => {
    const res = await run('/q/abc123');

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/gate');
    expect(location.searchParams.get('next')).toBe('/q/abc123');
  });

  it('answers API calls with a status instead of a redirect', async () => {
    const res = await run('/api/queries');

    // A fetch following a 307 to an HTML page produces a confusing parse error
    // at the call site; 401 says what actually happened.
    expect(res.status).toBe(401);
  });

  it('lets a valid session cookie through', async () => {
    const res = await run('/q/abc123', { cookie: await sessionCookie() });

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('lets a machine token through so the CLI keeps working', async () => {
    vi.stubEnv('FF_MACHINE_TOKEN', 'a-long-enough-machine-token');
    const res = await run('/api/queries', { auth: 'Bearer a-long-enough-machine-token' });

    expect(res.status).not.toBe(401);
  });

  it('rejects a wrong machine token', async () => {
    vi.stubEnv('FF_MACHINE_TOKEN', 'a-long-enough-machine-token');
    const res = await run('/api/queries', { auth: 'Bearer not-the-right-token-value' });

    expect(res.status).toBe(401);
  });

  // Each of these is reached by something that has no cookie to present, so
  // gating it breaks a real caller rather than protecting anything.
  it.each([
    ['/gate', 'the gate itself, or unlocking is impossible'],
    ['/api/gate', 'the form the gate posts to'],
    ['/api/health', 'the container healthcheck'],
    ['/api/version', 'the deploy version probe'],
    ['/api/cron/scrape', 'cron, which carries CRON_SECRET instead'],
    ['/api/community/ingest', 'community sync, which carries its own bearer key'],
    ['/api/analytics/track', "middleware's own internal beacon"],
    ['/sw.js', 'the service worker, or the PWA stops updating'],
    ['/manifest.json', 'the PWA manifest'],
    ['/icon-192.png', 'icons, fetched without cookies'],
    ['/robots.txt', 'crawlers, which get Disallow rather than a login page'],
  ])('leaves %s reachable (%s)', async path => {
    const res = await run(path);

    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(401);
  });

  it('still gates the sitemap, which lists private query ids', async () => {
    const res = await run('/sitemap.xml');

    expect(res.status).toBe(307);
  });

  it('gates the admin surface too', async () => {
    const res = await run('/admin');

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/gate');
  });
});
