import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { encryptSecret, decryptSecret } from '@/lib/secret-crypto';
import type {
  ChannelType,
  ChannelConfigMap,
  TelegramConfig,
  EmailConfig,
  NtfyConfig,
  WebhookConfig,
} from './types';

export const CHANNEL_TYPES: ChannelType[] = ['telegram', 'email', 'ntfy', 'webhook'];

/** Secret fields per channel type — encrypted at rest, redacted on read. */
export const SECRET_FIELDS: Record<ChannelType, string[]> = {
  telegram: ['botToken'],
  email: ['pass'],
  ntfy: ['token'],
  webhook: ['secret'],
};

export function isChannelType(v: unknown): v is ChannelType {
  return typeof v === 'string' && (CHANNEL_TYPES as string[]).includes(v);
}

function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('config must be an object');
  }
  return raw as Record<string, unknown>;
}

function reqStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`config.${key} is required`);
  return v;
}

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`config.${key} must be a string`);
  return v;
}

function validateTelegram(o: Record<string, unknown>): TelegramConfig {
  return { botToken: reqStr(o, 'botToken'), chatId: reqStr(o, 'chatId') };
}

function validateEmail(o: Record<string, unknown>): EmailConfig {
  const portRaw = o.port;
  const port = typeof portRaw === 'number' ? portRaw : Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error('config.port must be a valid port');
  return {
    host: reqStr(o, 'host'),
    port: Math.round(port),
    secure: o.secure === true,
    user: optStr(o, 'user'),
    pass: optStr(o, 'pass'),
    from: reqStr(o, 'from'),
    to: reqStr(o, 'to'),
  };
}

function validateNtfy(o: Record<string, unknown>): NtfyConfig {
  return {
    server: optStr(o, 'server') ?? 'https://ntfy.sh',
    topic: reqStr(o, 'topic'),
    token: optStr(o, 'token'),
  };
}

function validateWebhook(o: Record<string, unknown>): WebhookConfig {
  return { url: reqStr(o, 'url'), secret: optStr(o, 'secret') };
}

/** Validate + normalise a raw config object into the typed shape for `type`. */
export function validateChannelConfig<T extends ChannelType>(type: T, raw: unknown): ChannelConfigMap[T] {
  const o = obj(raw);
  switch (type) {
    case 'telegram':
      return validateTelegram(o) as ChannelConfigMap[T];
    case 'email':
      return validateEmail(o) as ChannelConfigMap[T];
    case 'ntfy':
      return validateNtfy(o) as ChannelConfigMap[T];
    case 'webhook':
      return validateWebhook(o) as ChannelConfigMap[T];
    default:
      throw new Error(`Unknown channel type: ${type as string}`);
  }
}

/** Encrypt secret fields before persisting. Non-secret fields pass through. */
export function encryptChannelConfig(type: ChannelType, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const field of SECRET_FIELDS[type]) {
    const v = out[field];
    if (typeof v === 'string' && v.length > 0) out[field] = encryptSecret(v);
  }
  return out;
}

/** Decrypt secret fields read from the DB and return the validated typed config. */
export function decryptChannelConfig<T extends ChannelType>(type: T, stored: unknown): ChannelConfigMap[T] {
  const out = { ...obj(stored) };
  for (const field of SECRET_FIELDS[type]) {
    const v = out[field];
    if (typeof v === 'string' && v.length > 0) out[field] = decryptSecret(v);
  }
  return validateChannelConfig(type, out);
}

/** Validate plaintext input and encrypt its secret fields, returning the row to store. */
export function prepareStoredConfig(type: ChannelType, input: unknown): Record<string, unknown> {
  const validated = validateChannelConfig(type, input) as unknown as Record<string, unknown>;
  return encryptChannelConfig(type, validated);
}

/**
 * Merge a partial plaintext update onto an existing stored (encrypted) config.
 * For secret fields: a non-empty string is re-encrypted, an explicit `null`
 * clears it, and blank/absent keeps the existing encrypted value. The merged
 * result is validated by decrypting it, so clearing a *required* secret (or a
 * missing required field) still fails.
 */
export function mergeStoredConfig(
  type: ChannelType,
  existingStored: unknown,
  input: unknown,
): Record<string, unknown> {
  const existing = obj(existingStored);
  const update = obj(input);
  const merged: Record<string, unknown> = { ...existing };
  const secrets = SECRET_FIELDS[type];
  for (const [k, v] of Object.entries(update)) {
    if (secrets.includes(k)) {
      if (v === null) {
        delete merged[k]; // explicit clear of an optional secret
      } else if (typeof v === 'string' && v.length > 0) {
        merged[k] = encryptSecret(v);
      }
      // blank/absent secret → keep the existing encrypted value
    } else {
      merged[k] = v;
    }
  }
  decryptChannelConfig(type, merged); // throws if the merged result is invalid
  return merged;
}

/** Strip secret values for safe return to the client, adding `<field>Set` flags. */
export function redactChannelConfig(type: ChannelType, stored: unknown): Record<string, unknown> {
  const o = obj(stored);
  const secrets = SECRET_FIELDS[type];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!secrets.includes(k)) out[k] = v;
  }
  for (const field of secrets) {
    out[`${field}Set`] = typeof o[field] === 'string' && (o[field] as string).length > 0;
  }
  return out;
}

/**
 * Reject URLs that could reach internal infrastructure (SSRF). Global/admin
 * channels are trusted (the operator's own machine); per-user channels in
 * multi-user mode are not, so a non-admin owner cannot aim a webhook or custom
 * ntfy server at localhost, link-local (incl. cloud metadata at
 * 169.254.169.254), or private ranges (127.0.0.0/8, 10/8, 172.16/12,
 * 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10).
 *
 * Literal-host based: this checks the literal IP or hostname only, it does not
 * resolve DNS. A hostname that resolves to a private address (the DNS rebinding
 * class, SSRF-5) is therefore only partially mitigated here. Full mitigation
 * needs resolve-and-pin at the socket layer, which we deliberately do not do
 * in this layer; the literal checks below are kept robust as the first line.
 */
export function assertPublicUrl(rawUrl: string, opts: { trusted: boolean }): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('URL must not embed credentials');
  }
  if (opts.trusted) return;
  if (isPrivateHost(url.hostname.toLowerCase())) {
    throw new Error('URL host is not allowed');
  }
}

/**
 * SSRF guard for a bare host (no URL wrapper), used for SMTP hosts. Trusted
 * (admin/global) channels may target a private mail relay; untrusted per-user
 * channels may not, so a non-admin owner cannot point email delivery at
 * localhost, link-local (incl. 169.254.169.254), or private ranges. Same
 * literal-only caveat as assertPublicUrl: DNS rebinding is only partially
 * mitigated here.
 */
export function assertPublicHost(host: string, opts: { trusted: boolean }): void {
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('Host is required');
  }
  if (opts.trusted) return;
  if (isPrivateHost(host.trim().toLowerCase())) {
    throw new Error('SMTP host is not allowed');
  }
}

/**
 * Resolve `rawUrl`'s host and return an undici dispatcher pinned to a validated
 * public address, or undefined when no pinning is needed (trusted channel, or a
 * literal IP that assertPublicUrl already checked). For untrusted channels this
 * resolves the hostname, rejects if ANY resolved address is private, and pins
 * the socket to the checked address so the connection cannot rebind to an
 * internal IP between this check and the request (the DNS rebinding class, SSRF-5).
 */
export async function pinnedPublicDispatcher(
  rawUrl: string,
  opts: { trusted: boolean },
): Promise<Agent | undefined> {
  assertPublicUrl(rawUrl, opts);
  if (opts.trusted) return undefined;
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // assertPublicUrl already validated a literal IP host; there is no name to pin.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return undefined;

  const resolved = await dnsLookup(host, { all: true });
  if (resolved.length === 0) throw new Error('URL host did not resolve');
  for (const r of resolved) {
    if (isPrivateHost(r.address)) throw new Error('URL host is not allowed');
  }

  const pinned = resolved[0]!;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
  return new Agent({ connect: { lookup } });
}

/**
 * Resolve an SMTP host and return the validated public IP to connect to, so the
 * caller can PIN the socket to that address (passing it as the transport host)
 * while keeping the original hostname for TLS identity. This closes the DNS
 * rebinding gap (SSRF-5): nodemailer re-resolves the name otherwise, so a host
 * that passed the check could resolve to an internal IP at connect time.
 *
 * Returns `null` when no pinning is needed: a trusted (admin/global) channel, or
 * a literal IP that assertPublicHost already checked (there is no name to pin).
 * Otherwise it rejects if `host` (or any address it resolves to) is private and
 * returns the first validated address.
 */
export async function resolvePinnedPublicHost(host: string, opts: { trusted: boolean }): Promise<string | null> {
  assertPublicHost(host, opts);
  if (opts.trusted) return null;
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return null; // literal IP already checked
  const resolved = await dnsLookup(h, { all: true });
  if (resolved.length === 0) throw new Error('SMTP host did not resolve');
  for (const r of resolved) {
    if (isPrivateHost(r.address)) throw new Error('SMTP host is not allowed');
  }
  return resolved[0]!.address;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase(); // strip IPv6 brackets, normalise

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    // A literal with an out-of-range octet is a malformed numeric host; block
    // it rather than trusting how a downstream resolver might reinterpret it.
    if (octets.some((o) => o > 255)) return true;
    return isPrivateIPv4(octets);
  }

  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
  if (h.startsWith('fe80')) return true; // link-local

  // IPv4-mapped IPv6, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1) form.
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1]!;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateHost(tail);
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
    }
    return true; // unrecognised mapped form — block conservatively
  }
  return false;
}
