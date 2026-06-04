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
 * Secret fields left blank keep their existing encrypted value; provided ones
 * are re-encrypted. The merged result is validated by decrypting it, so a
 * missing required field still fails.
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
      if (typeof v === 'string' && v.length > 0) merged[k] = encryptSecret(v);
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
 * 169.254.169.254), or private ranges.
 *
 * Literal-host based: this does not resolve DNS, so a hostname that resolves to
 * a private address is not caught here. Acceptable for the household multi-user
 * threat model; revisit with resolve-and-pin if instances open to the public.
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

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const h = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice('::ffff:'.length)); // IPv4-mapped
  return false;
}
