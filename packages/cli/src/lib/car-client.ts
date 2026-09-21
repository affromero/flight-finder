import { travelRequest } from '../../../../apps/web/src/components/travel/client.js';

interface CarRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  idempotencyKey?: string;
  revision?: number;
}
export interface CarSession { scope: string; isAdmin: boolean }
export class CarScopeError extends Error {
  constructor() { super('Car account changed; reload before continuing'); this.name = 'CarScopeError'; }
}

/** Car-only transport; mutation callers own durable receipts and acknowledgement validation. */
export class CarClient {
  readonly origin: string;
  constructor(baseUrl: string, private readonly session?: string, private readonly accessToken?: string) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Car server must be an HTTP(S) origin without a path or embedded credentials');
    }
    if (session && /[\r\n;]/.test(session)) throw new Error('FLIGHT_FINDER_SESSION must contain only the ft-session cookie value');
    if (accessToken && /[\r\n]/.test(accessToken)) throw new Error('Invalid device access token');
    this.origin = url.origin;
  }

  async getSession(signal?: AbortSignal): Promise<CarSession> {
    const raw = await this.request<unknown>('/api/cars/session', { signal });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('scope' in raw) || !('isAdmin' in raw)
      || Object.keys(raw).some(key => key !== 'scope' && key !== 'isAdmin')
      || typeof raw.scope !== 'string' || typeof raw.isAdmin !== 'boolean'
      || !(raw.scope === 'single' ? raw.isAdmin : /^user:[A-Za-z0-9_-]{1,200}$/.test(raw.scope))) {
      throw new Error('Car server returned an invalid account scope');
    }
    return { scope: raw.scope, isAdmin: raw.isAdmin };
  }

  async request<T>(path: string, options: CarRequestOptions = {}): Promise<T> {
    const pathname = path.split('?')[0]!;
    if (!/^\/api\/cars(?:\/|$)/.test(pathname) || /[\\#\s]/.test(path) || /%(?:2e|2f|5c|25)/i.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('Invalid car API path');
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !/^\/api\/cars(?:\/|$)/.test(url.pathname)) throw new Error('Invalid car API destination');
    const timeoutMs = options.timeoutMs ?? 30_000, maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Car request timeout must be from 1 to 300000 milliseconds');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024) throw new Error('Invalid car response size limit');
    if (options.revision !== undefined && (!Number.isSafeInteger(options.revision) || options.revision < 0 || options.revision > 2147483647)) throw new Error('Invalid car revision');
    const timeout = AbortSignal.timeout(timeoutMs);
    return travelRequest<T>(url.href, {
      method: options.method ?? 'GET', redirect: 'error', cache: 'no-store',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: {
        Origin: this.origin,
        ...(this.session ? { Cookie: `ft-session=${this.session}` } : {}),
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        ...(options.revision === undefined ? {} : { 'X-Car-Revision': String(options.revision) }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }, { maxResponseBytes });
  }
}
