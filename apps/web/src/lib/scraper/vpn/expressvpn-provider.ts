import { isIP } from 'node:net';
import { lookupCountry } from '../../country-lookup';
import type { VpnProvider, VpnStatus } from './types';

const POLL_INTERVAL_MS = 3000;
const CONNECT_TIMEOUT_MS = 45000;
const DEFAULT_API_URL = 'http://expressvpn:8000';

/** Existing country preferences map to the same provider regions. */
const EXPRESSVPN_SERVERS: Record<string, string> = {
  US: 'usny', GB: 'uklo', DE: 'defra1', FR: 'frpa2', ES: 'esma', IT: 'itco',
  NL: 'nlam', IE: 'ie', JP: 'jpto', KR: 'kr2', IN: 'inuk', AU: 'ausy',
  CA: 'cato', MX: 'mx', BR: 'br', AR: 'ar', CO: 'co', TH: 'th', SG: 'sgcb', HK: 'hk2',
};
const SIDECAR_REGIONS: Record<string, string> = {
  US: 'us-new-york', GB: 'uk-london', DE: 'germany-frankfurt', FR: 'france-paris',
  ES: 'spain-madrid', IT: 'italy-cosenza', NL: 'netherlands-amsterdam', IE: 'ireland',
  JP: 'japan-tokyo', KR: 'south-korea', IN: 'india-via-uk', AU: 'australia-sydney',
  CA: 'canada-toronto', MX: 'mexico', BR: 'brazil', AR: 'argentina', CO: 'colombia',
  TH: 'thailand', SG: 'singapore', HK: 'hong-kong',
};

async function withDeadline<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('VPN operation timed out; network state is unconfirmed')), milliseconds);
  try {
    const result = await work(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally { clearTimeout(timeout); }
}

async function sidecarApi(apiUrl: string, path: string, signal: AbortSignal, method: 'GET' | 'POST' = 'GET', body?: string): Promise<string> {
  signal.throwIfAborted();
  const res = await fetch(apiUrl + path, {
    method, signal, redirect: 'error', ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error('VPN API ' + path + ' returned HTTP ' + res.status);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('VPN API returned an empty response');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) throw new Error('VPN API response is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function objectFrom(text: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid VPN API response');
  return raw as Record<string, unknown>;
}

async function readStatus(apiUrl: string, signal: AbortSignal): Promise<{ status: VpnStatus; modern: boolean }> {
  const text = await sidecarApi(apiUrl, '/v1/status', signal);
  if (text.startsWith('{')) {
    const raw = objectFrom(text);
    if (typeof raw.connected !== 'boolean' || typeof raw.server !== 'string' || typeof raw.status !== 'string'
      || /not running/i.test(raw.status) || (raw.connected && !raw.server.trim())) throw new Error('Invalid or unavailable VPN status');
    // A failed sidecar connection-state command can also produce connected:false.
    const states = raw.status.split(/\r?\n/).flatMap(line => {
      const match = /^(?:Connection state:\s*)?(Not connected|Disconnected|Connected(?: to .+)?)$/i.exec(line.trim());
      if (!match && /^(?:Connection state:|Connecting\b|Disconnecting\b|Reconnecting\b)/i.test(line.trim())) throw new Error('VPN connection state is not verified');
      return match ? [/^Connected(?: to |$)/i.test(match[1]!)] : [];
    });
    if (!states.length || states.some(state => state !== raw.connected)) throw new Error('VPN connection state is not verified');
    return { modern: true, status: { connected: raw.connected, currentLocation: raw.connected ? raw.server.trim() : null, currentCountry: null } };
  }
  if (/^(?:Not connected|Disconnected)$/i.test(text)) return { modern: false, status: { connected: false, currentLocation: null, currentCountry: null } };
  const connected = /^Connected to ([^\r\n]+)$/i.exec(text);
  if (!connected?.[1]?.trim()) throw new Error('Invalid or unavailable VPN status');
  return { modern: false, status: { connected: true, currentLocation: connected[1].trim(), currentCountry: null } };
}

function acknowledge(text: string, modern: boolean, expected: string): void {
  if (modern ? objectFrom(text).success !== true : text !== expected) throw new Error('VPN did not acknowledge ' + expected.toLowerCase());
}

async function sidecarRegion(apiUrl: string, country: string, signal: AbortSignal): Promise<string> {
  const raw: unknown = JSON.parse(await sidecarApi(apiUrl, '/v1/servers', signal));
  if (!Array.isArray(raw) || raw.length > 10000 || raw.some(value => typeof value !== 'string' || !value || value.length > 200)) throw new Error('Invalid VPN regions');
  const region = SIDECAR_REGIONS[country];
  const selected = [region, region + '-1', EXPRESSVPN_SERVERS[country]].find(value => value && raw.includes(value));
  if (!selected) throw new Error('The configured VPN region is unavailable for ' + country);
  return selected;
}

async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, POLL_INTERVAL_MS);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class ExpressVpnProvider implements VpnProvider {
  readonly type = 'expressvpn' as const;

  constructor(private readonly apiUrl = process.env.EXPRESSVPN_API_URL || DEFAULT_API_URL,
    private readonly proxyUrl = process.env.EXPRESSVPN_SOCKS_URL || undefined) {}

  getProxyUrl(): string | undefined { return this.proxyUrl; }

  async getStatus(): Promise<VpnStatus> {
    return withDeadline(10_000, async signal => (await readStatus(this.apiUrl, signal)).status);
  }

  async connect(countryCode: string): Promise<boolean> {
    const server = EXPRESSVPN_SERVERS[countryCode.toUpperCase()];
    if (!server) return false;
    return withDeadline(CONNECT_TIMEOUT_MS, async signal => {
      const { modern } = await readStatus(this.apiUrl, signal);
      const acknowledgement = modern
        ? await sidecarApi(this.apiUrl, '/v1/connect', signal, 'POST', JSON.stringify({ server: await sidecarRegion(this.apiUrl, countryCode.toUpperCase(), signal) }))
        : await sidecarApi(this.apiUrl, '/v1/connect/' + server, signal, 'POST');
      acknowledge(acknowledgement, modern, 'Connected');
      while (true) {
        const { status } = await readStatus(this.apiUrl, signal);
        if (status.connected) {
          const ipText = await sidecarApi(this.apiUrl, '/v1/publicip/ip', signal);
          const exitIp = modern ? objectFrom(ipText).public_ip : ipText;
          if (typeof exitIp !== 'string' || !isIP(exitIp)) throw new Error('VPN exit IP is not verified');
          const exitCountry = lookupCountry(exitIp);
          signal.throwIfAborted();
          const requestedCountry = countryCode.toUpperCase();
          if (exitCountry !== requestedCountry) throw new Error('VPN exit country is ' + (exitCountry ?? 'unknown') + '; expected ' + requestedCountry);
          return true;
        }
        await pause(signal);
      }
    });
  }

  async disconnect(): Promise<void> {
    await withDeadline(CONNECT_TIMEOUT_MS, async signal => {
      const { status, modern } = await readStatus(this.apiUrl, signal);
      if (!status.connected) return;
      acknowledge(await sidecarApi(this.apiUrl, '/v1/disconnect', signal, 'POST'), modern, 'Disconnected');
      while (true) {
        if (!(await readStatus(this.apiUrl, signal)).status.connected) return;
        await pause(signal);
      }
    });
  }

  async listLocations(): Promise<string[]> {
    return Object.entries(EXPRESSVPN_SERVERS).map(([code, alias]) => code + ': ' + alias);
  }

  isSystemWide(): boolean { return !this.proxyUrl; }
}
