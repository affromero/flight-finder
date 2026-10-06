import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MullvadVpnProvider } from '../mullvad-provider';
import { createVpnProvider } from '..';
import type { VpnProviderType } from '../types';
import { tailscaleVpnConfig } from '../tailscale-config';

const proxyUrl = 'socks5://tailscale:1055';
const disconnected = { connected: false, currentLocation: null, currentCountry: null, proxyUrl };
let server: Server, provider: MullvadVpnProvider;
let respond: (path: string) => unknown;
let httpStatus: number, hang: boolean, large: boolean;
let onMutation: (() => void) | undefined;
const paths: string[] = [];

beforeEach(async () => {
  paths.length = 0; httpStatus = 200; hang = false; large = false; onMutation = undefined;
  respond = path => path === '/v1/locations' ? { locations: ['US: Mullvad', 'DE: Mullvad', 'ZA: Mullvad'], proxyUrl }
    : path === '/v1/connect/US' ? { connected: true, currentLocation: 'us.mullvad.ts.net', currentCountry: 'US', success: true, exitIp: '8.8.8.8', proxyUrl }
      : { ...disconnected, success: true };
  server = createServer((req, res) => {
    const path = req.url ?? ''; paths.push(path);
    if (path.startsWith('/v1/connect/')) { onMutation?.(); if (hang) return; }
    res.writeHead(httpStatus, httpStatus === 302 ? { Location: '/unexpected' } : { 'Content-Type': 'application/json' });
    res.end(large ? 'x'.repeat(65_537) : JSON.stringify(respond(path)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected local fixture address');
  provider = new MullvadVpnProvider({ apiUrl: 'http://127.0.0.1:' + address.port, proxyUrl });
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });

describe('Mullvad provider over real HTTP with the installed country database', () => {
  it('exposes only available countries with canonical browser profiles', async () => {
    expect(await provider.listLocations()).toEqual(['US: Mullvad', 'DE: Mullvad']);
    expect(await provider.getStatus()).toEqual({ connected: false, currentLocation: null, currentCountry: null });
    expect(provider.getProxyUrl()).toBe(proxyUrl);
    expect(provider.isSystemWide()).toBe(false);
  });
  it('verifies a real country address before accepting the selected exit', async () => {
    await expect(provider.connect('US')).resolves.toBe(true);
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });
  it('rejects unavailable and unsupported countries without sending a mutation', async () => {
    expect(await provider.connect('ZA')).toBe(false);
    expect(await provider.connect('GB')).toBe(false);
    expect(await provider.connect('bad')).toBe(false);
    expect(paths.some(path => path.startsWith('/v1/connect/'))).toBe(false);
  });
  it('rejects claimed country success when the observed exit belongs to another country', async () => {
    respond = path => path === '/v1/locations' ? { locations: ['DE: Mullvad'], proxyUrl }
      : { connected: true, currentLocation: 'de.mullvad.ts.net', currentCountry: 'DE', success: true, exitIp: '8.8.8.8', proxyUrl };
    await expect(provider.connect('DE')).rejects.toThrow(/exit country/);
  });
  it('does not accept a private exit address as a country verification', async () => {
    respond = path => path === '/v1/locations' ? { locations: ['US: Mullvad'], proxyUrl }
      : { connected: true, currentLocation: 'us.mullvad.ts.net', currentCountry: 'US', success: true, exitIp: '192.168.1.1', proxyUrl };
    await expect(provider.connect('US')).rejects.toThrow(/exit country/);
  });
  it('rejects a bridge bound to a different browser proxy', async () => {
    respond = () => ({ ...disconnected, proxyUrl: 'socks5://other-daemon:1055' });
    await expect(provider.getStatus()).rejects.toThrow(/proxy identity/);
  });
  it('rejects malformed connection state', async () => {
    respond = () => ({ ...disconnected, connected: 'false' });
    await expect(provider.getStatus()).rejects.toThrow(/Unverified/);
  });
  it('does not follow a redirected control-plane response', async () => {
    httpStatus = 302;
    await expect(provider.getStatus()).rejects.toThrow();
    expect(paths).not.toContain('/unexpected');
  });
  it('bounds bridge response size and surfaces non-success responses', async () => {
    large = true; await expect(provider.getStatus()).rejects.toThrow(/too large/);
    httpStatus = 503; await expect(provider.getStatus()).rejects.toThrow(/HTTP 503/);
  });
  it('cancels an in-flight HTTP mutation with the job signal', async () => {
    hang = true;
    const controller = new AbortController();
    const reached = new Promise<void>(resolve => { onMutation = resolve; });
    const pending = provider.connect('US', controller.signal);
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    await reached; controller.abort(); await rejected;
  });
  it('rejects an already cancelled job before sending any requests', async () => {
    await expect(provider.getStatus(AbortSignal.abort())).rejects.toThrow(/abort/i);
    expect(paths).toEqual([]);
  });
  it('preserves the explicit disabled default and refuses unsupported provider metadata', () => {
    expect(createVpnProvider('none').type).toBe('none');
    expect(() => createVpnProvider('invalid' as VpnProviderType)).toThrow(/Unsupported/);
  });
  it('captures normalized dedicated endpoints and rejects credentials and paths', () => {
    vi.stubEnv('TAILSCALE_VPN_API_URL', 'http://TAILSCALE-vpn:8000/');
    vi.stubEnv('TAILSCALE_VPN_SOCKS_URL', proxyUrl);
    expect(tailscaleVpnConfig()).toEqual({ apiUrl: 'http://tailscale-vpn:8000', proxyUrl });
    vi.stubEnv('TAILSCALE_VPN_API_URL', 'http://private:credential@tailscale-vpn:8000');
    expect(tailscaleVpnConfig).toThrow(/configuration/);
    vi.stubEnv('TAILSCALE_VPN_API_URL', 'http://tailscale-vpn:8000');
    vi.stubEnv('TAILSCALE_VPN_SOCKS_URL', 'socks5://tailscale:1055/other');
    expect(tailscaleVpnConfig).toThrow(/configuration/);
  });
});
