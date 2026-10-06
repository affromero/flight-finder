import { isIP } from 'node:net';
import { lookupCountry } from '../../country-lookup';
import { getCountryProfile } from '../country-profiles';
import type { VpnProvider, VpnStatus } from './types';
import { tailscaleVpnConfig } from './tailscale-config';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tailscale VPN response');
  return value as Record<string, unknown>;
}

function statusFrom(raw: Record<string, unknown>): VpnStatus {
  if (typeof raw.connected !== 'boolean'
    || (raw.connected ? typeof raw.currentLocation !== 'string' || !raw.currentLocation
      || typeof raw.currentCountry !== 'string' || !/^[A-Z]{2}$/.test(raw.currentCountry)
      : raw.currentLocation !== null || raw.currentCountry !== null)) throw new Error('Unverified Tailscale VPN status');
  return { connected: raw.connected, currentLocation: raw.currentLocation as string | null, currentCountry: raw.currentCountry as string | null };
}

/** Uses a dedicated userspace daemon. Every response must bind to its SOCKS proxy. */
export class MullvadVpnProvider implements VpnProvider {
  readonly type = 'mullvad' as const;
  constructor(private readonly config = tailscaleVpnConfig()) {}
  getProxyUrl(): string { return this.config.proxyUrl; }
  isSystemWide(): boolean { return false; }

  private async request(path: string, method = 'GET', cancellation?: AbortSignal): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.timeout(method === 'GET' ? 10_000 : 55_000);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    signal.throwIfAborted();
    const response = await fetch(this.config.apiUrl + path, { method, signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Tailscale VPN returned HTTP ' + response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty Tailscale VPN response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) throw new Error('Tailscale VPN response is too large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const raw = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (raw.proxyUrl !== this.config.proxyUrl) throw new Error('Tailscale VPN proxy identity does not match the configured browser proxy');
    return raw;
  }

  async getStatus(signal?: AbortSignal): Promise<VpnStatus> { return statusFrom(await this.request('/v1/status', 'GET', signal)); }

  async listLocations(signal?: AbortSignal): Promise<string[]> {
    const { locations } = await this.request('/v1/locations', 'GET', signal);
    if (!Array.isArray(locations) || locations.length > 300 || locations.some(value => typeof value !== 'string' || !/^[A-Z]{2}: .{1,200}$/.test(value))) {
      throw new Error('Invalid Mullvad locations');
    }
    return locations.filter((location: string) => getCountryProfile(location.slice(0, 2)) !== undefined);
  }

  async connect(countryCode: string, signal?: AbortSignal): Promise<boolean> {
    const country = countryCode.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !getCountryProfile(country)) return false;
    if (!(await this.listLocations(signal)).some(location => location.startsWith(country + ': '))) return false;
    const raw = await this.request('/v1/connect/' + country, 'POST', signal);
    const status = statusFrom(raw);
    if (raw.success !== true || !status.connected || status.currentCountry !== country
      || typeof raw.exitIp !== 'string' || !isIP(raw.exitIp)) throw new Error('Mullvad connection is not verified');
    if (lookupCountry(raw.exitIp) !== country) throw new Error('Mullvad exit country does not match ' + country);
    signal?.throwIfAborted();
    return true;
  }

  async disconnect(signal?: AbortSignal): Promise<void> {
    const raw = await this.request('/v1/disconnect', 'POST', signal);
    if (raw.success !== true || statusFrom(raw).connected) throw new Error('Mullvad disconnection is not verified');
  }
}
