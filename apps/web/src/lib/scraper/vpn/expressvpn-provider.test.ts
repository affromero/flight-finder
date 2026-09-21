import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpressVpnProvider } from './expressvpn-provider';

const lookupCountry = vi.hoisted(() => vi.fn());
vi.mock('../../country-lookup', () => ({ lookupCountry }));
let provider: ExpressVpnProvider;
const http = vi.fn<typeof fetch>();
const modernStatus = (connected: boolean) => JSON.stringify({ connected, server: connected ? 'uk-london' : '', status: connected ? 'Connected' : 'Disconnected', ip: '' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', http);
  vi.stubEnv('EXPRESSVPN_API_URL', 'http://vpn.test');
  provider = new ExpressVpnProvider();
  http.mockReset();
  lookupCountry.mockReset().mockReturnValue('GB');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function responses(...bodies: string[]) {
  for (const body of bodies) http.mockResolvedValueOnce(new Response(body));
}

describe('VPN status observations', () => {
  it('keeps the admitted endpoint and proxy when process configuration changes', async () => {
    vi.stubEnv('EXPRESSVPN_SOCKS_URL', 'socks5://original.test:1080');
    const captured = new ExpressVpnProvider();
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://replacement.test');
    vi.stubEnv('EXPRESSVPN_SOCKS_URL', '');
    responses('Not connected');
    await captured.getStatus();
    expect(http.mock.calls[0]?.[0]).toBe('http://vpn.test/v1/status');
    expect(captured.getProxyUrl()).toBe('socks5://original.test:1080');
    expect(captured.isSystemWide()).toBe(false);
  });
  it.each(['Not connected', 'Disconnected', ' Not connected\n'])('recognizes an explicit disconnected response: %s', async status => {
    responses(status);
    await expect(provider.getStatus()).resolves.toEqual({ connected: false, currentLocation: null, currentCountry: null });
  });
  it('does not infer a country from an alias appearing inside a location name', async () => {
    responses('Connected to Mexico City');
    await expect(provider.getStatus()).resolves.toEqual({ connected: true, currentLocation: 'Mexico City', currentCountry: null });
  });
  it.each(['', 'Connecting', 'Not connected to a server', '<html>Connected to London</html>', 'Connected to London\nNot connected'])('rejects ambiguous status instead of claiming direct traffic is safe: %s', async status => {
    responses(status);
    await expect(provider.getStatus()).rejects.toThrow(/status|empty/i);
  });
  it.each([401, 403, 500, 502])('surfaces HTTP %i even when its body looks disconnected', async status => {
    http.mockResolvedValue(new Response('Not connected', { status }));
    await expect(provider.getStatus()).rejects.toThrow(String(status));
  });
  it('surfaces transport failure rather than returning disconnected', async () => {
    http.mockRejectedValue(new Error('Connection refused'));
    await expect(provider.getStatus()).rejects.toThrow(/refused/);
  });
  it('rejects oversized responses', async () => {
    responses('Connected to ' + 'x'.repeat(65_536));
    await expect(provider.getStatus()).rejects.toThrow(/large/);
  });
  it.each([true, false])('reads modern JSON status connected=%s', async connected => {
    responses(modernStatus(connected));
    await expect(provider.getStatus()).resolves.toMatchObject({ connected, currentLocation: connected ? 'uk-london' : null });
  });
  it.each([
    { connected: false, server: '', status: 'ExpressVPN not running' },
    { connected: false, server: '', status: '' },
    { connected: 'false', server: '', status: 'Disconnected' },
    { connected: true, server: '', status: 'Connected' },
    { connected: false, server: '', status: 'Disconnected\nConnection state: Connected' },
    { connected: true, server: 'uk-london', status: 'Connected\nConnection state: Disconnected' },
    { connected: true, server: 'uk-london', status: 'Disconnected' },
    { connected: true, server: 'uk-london', status: 'Connected\nConnection state: Connecting' },
  ])('does not mistake unavailable or malformed JSON status for a safe connection state: %j', async status => {
    responses(JSON.stringify(status));
    await expect(provider.getStatus()).rejects.toThrow(/status|verified/);
  });
  it('bounds the entire status request, including a stalled response body', async () => {
    http.mockImplementation(async (...[, init]) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true }); },
    })));
    const result = expect(provider.getStatus()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
  });
});

describe('verified VPN mutations', () => {
  it('connects through the local bridge only after the exit IP resolves to the requested country', async () => {
    responses('Not connected', 'Connected', 'Connected to UK - London', '203.0.113.8');
    await expect(provider.connect('gb')).resolves.toBe(true);
    expect(http.mock.calls).toContainEqual(['http://vpn.test/v1/connect/uklo', expect.objectContaining({ method: 'POST', redirect: 'error' })]);
    expect(lookupCountry.mock.calls).toContainEqual(['203.0.113.8']);
  });
  it('uses the current sidecar JSON API without retrying a different mutation endpoint', async () => {
    responses(modernStatus(false), '["us-new-york","uk-london"]', '{"success":true}', modernStatus(true), '{"public_ip":"203.0.113.8"}');
    await expect(provider.connect('GB')).resolves.toBe(true);
    expect(http.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([
      ['http://vpn.test/v1/connect', expect.objectContaining({ body: '{"server":"uk-london"}', headers: { 'Content-Type': 'application/json' } })],
    ]);
  });
  it('selects a numbered modern region only when advertised by the sidecar', async () => {
    responses(modernStatus(false), '["uk-london-1"]', '{"success":true}', modernStatus(true), '{"public_ip":"203.0.113.8"}');
    await expect(provider.connect('GB')).resolves.toBe(true);
    expect(http.mock.calls).toContainEqual(['http://vpn.test/v1/connect', expect.objectContaining({ body: '{"server":"uk-london-1"}' })]);
  });
  it.each(['["us-new-york"]', '[]', '[null]', '{}'])('rejects missing or malformed modern regions without a mutation: %s', async regions => {
    responses(modernStatus(false), regions);
    await expect(provider.connect('GB')).rejects.toThrow(/region/);
    expect(http.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });
  it('surfaces a rejected connection command without retrying it', async () => {
    responses('Not connected');
    http.mockResolvedValue(new Response('Connected', { status: 500 }));
    await expect(provider.connect('GB')).rejects.toThrow(/500/);
    expect(http.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it.each(['US', null])('rejects a wrong or unknown exit country: %s', async country => {
    lookupCountry.mockReturnValue(country);
    responses('Not connected', 'Connected', 'Connected to UK - London', '203.0.113.8');
    await expect(provider.connect('GB')).rejects.toThrow(/exit country/);
  });
  it.each(['unknown', '', 'not-an-ip', '203.0.113.8 extra'])('rejects an unverifiable exit IP: %s', async ip => {
    responses('Not connected', 'Connected', 'Connected to UK - London', ip);
    await expect(provider.connect('GB')).rejects.toThrow(/IP/);
  });
  it('surfaces unavailable geographic data', async () => {
    lookupCountry.mockImplementation(() => { throw new Error('Geo database unavailable'); });
    responses('Not connected', 'Connected', 'Connected to UK - London', '203.0.113.8');
    await expect(provider.connect('GB')).rejects.toThrow(/database/);
  });
  it('does not mutate anything for unsupported countries', async () => {
    await expect(provider.connect('ZZ')).resolves.toBe(false);
    expect(http.mock.calls).toEqual([]);
  });
  it('rejects a modern API failure even if its HTTP status is successful', async () => {
    responses(modernStatus(false), '["uk-london"]', '{"success":false,"message":"failed"}');
    await expect(provider.connect('GB')).rejects.toThrow(/acknowledge/);
  });
  it('does not issue a disconnect after a failed status read', async () => {
    http.mockResolvedValue(new Response('Not connected', { status: 503 }));
    await expect(provider.disconnect()).rejects.toThrow(/503/);
    expect(http.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });
  it('verifies disconnection after a successful command acknowledgement', async () => {
    responses('Connected to UK - London', 'Disconnected', 'Not connected');
    await expect(provider.disconnect()).resolves.toBeUndefined();
    expect(http.mock.calls).toContainEqual(['http://vpn.test/v1/disconnect', expect.objectContaining({ method: 'POST' })]);
  });
  it('does not send a mutation when already explicitly disconnected', async () => {
    responses('Not connected');
    await expect(provider.disconnect()).resolves.toBeUndefined();
    expect(http.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });
  it('never turns a disconnect backend error into successful cleanup', async () => {
    responses('Connected to UK - London');
    http.mockResolvedValue(new Response('Disconnected', { status: 502 }));
    await expect(provider.disconnect()).rejects.toThrow(/502/);
  });
  it('times out disconnection if the provider remains connected', async () => {
    responses('Connected to UK - London', 'Disconnected');
    http.mockImplementation(async () => new Response('Connected to UK - London'));
    const result = expect(provider.disconnect()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(45_000);
    await result;
  });
  it('shares one connection deadline across the mutation and subsequent polling', async () => {
    http.mockImplementation(async (...[, init]) => {
      if (init?.method === 'POST') { await new Promise(resolve => setTimeout(resolve, 39_000)); return new Response('Connected'); }
      return new Response('Not connected');
    });
    const result = expect(provider.connect('GB')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(45_000);
    await result;
  });
});
