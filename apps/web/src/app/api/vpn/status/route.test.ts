import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const boundary = vi.hoisted(() => ({ config: null as { vpnProvider: string; vpnActivationCode?: string } | null }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findFirst: async () => boundary.config } } }));
let server: Server;
let malformed: boolean, mismatched: boolean, countries: string[], httpStatus: number;
const proxyUrl = 'socks5://tailscale:1055';
const mutations: string[] = [];
beforeEach(async () => {
  boundary.config = { vpnProvider: 'mullvad' }; malformed = false; mismatched = false; countries = ['US', 'DE', 'ZA']; httpStatus = 200; mutations.length = 0;
  server = createServer((req, res) => {
    if (req.method !== 'GET') mutations.push(req.url ?? '');
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/locations' ? { locations: countries.map(country => country + ': Mullvad'), proxyUrl }
      : { connected: malformed ? 'false' : false, currentLocation: null, currentCountry: null, proxyUrl: mismatched ? 'socks5://wrong:1055' : proxyUrl }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Expected fixture address');
  vi.stubEnv('TAILSCALE_VPN_API_URL', 'http://127.0.0.1:' + address.port);
  vi.stubEnv('EXPRESSVPN_API_URL', 'http://127.0.0.1:' + address.port);
  vi.stubEnv('TAILSCALE_VPN_SOCKS_URL', proxyUrl);
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });

describe('VPN readiness through real bridge HTTP', () => {
  it('readies Mullvad without an ExpressVPN activation code and reports supported countries', async () => {
    expect((await (await GET()).json()).data).toEqual({ provider: 'mullvad', configured: true, sidecarRunning: true, ready: true, countries: ['US', 'DE'] });
    expect(mutations).toEqual([]);
  });
  it.each(['malformed', 'mismatched', 'unavailable'] as const)('surfaces %s readiness as an explicit error without internal endpoints', async mode => {
    malformed = mode === 'malformed'; mismatched = mode === 'mismatched'; httpStatus = mode === 'unavailable' ? 503 : 200;
    const data = (await (await GET()).json()).data;
    expect(data).toMatchObject({ ready: false, sidecarRunning: false, error: expect.any(String) });
    expect(JSON.stringify(data)).not.toContain(proxyUrl);
  });
  it('does not claim ready when no country has a supported browser profile', async () => {
    countries = ['ZA'];
    expect((await (await GET()).json()).data).toMatchObject({ ready: false, countries: [], error: expect.stringMatching(/No available/) });
  });
  it('preserves ExpressVPN activation-code gating', async () => {
    boundary.config = { vpnProvider: 'expressvpn' };
    expect((await (await GET()).json()).data).toMatchObject({ configured: false, ready: false });
    boundary.config.vpnActivationCode = 'stored-encrypted-code';
    expect((await (await GET()).json()).data).toMatchObject({ configured: true, ready: true });
  });
  it('reports the disabled default without a bridge request', async () => {
    boundary.config = null;
    expect((await (await GET()).json()).data).toEqual({ provider: 'none', configured: false, sidecarRunning: false, ready: false });
  });
});
