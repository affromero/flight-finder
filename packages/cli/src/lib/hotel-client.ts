import type { HotelSearch, HotelSearchResult } from '../../../../apps/web/src/lib/hotels/types.js';

export interface HotelJob { id: string; status: string; result: HotelSearchResult | null; error: string | null }

export class HotelClient {
  private readonly origin: URL;
  constructor(baseUrl: string, private readonly session?: string, private readonly accessToken?: string) {
    this.origin = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.origin.protocol) || this.origin.username || this.origin.password) {
      throw new Error('Hotel server must be an HTTP(S) URL without embedded credentials');
    }
    if (session && /[\r\n;]/.test(session)) throw new Error('FLIGHT_FINDER_SESSION must contain only the ft-session cookie value');
  }

  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('/api/hotels')) throw new Error('Invalid hotel API path');
    const response = await fetch(new URL(path, this.origin), {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', ...(this.session ? { Cookie: `ft-session=${this.session}` } : {}), ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || !('ok' in payload)) throw new Error(`Hotel server returned an invalid response (HTTP ${response.status})`);
    if (!response.ok || !payload.ok) {
      const error = 'error' in payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(response.status === 401 ? `${error}. Set FLIGHT_FINDER_SESSION to your ft-session cookie value.` : error);
    }
    if (!('data' in payload)) throw new Error('Hotel server response is missing data');
    return payload.data as T;
  }

  async search(search: HotelSearch, options: { wait?: boolean; signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}): Promise<HotelJob> {
    const job = await this.request<HotelJob>('/api/hotels/search', 'POST', search, options.signal);
    if (!options.wait) return job;
    const deadline = Date.now() + (options.timeoutMs ?? 120 * 60_000);
    try {
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        const current = await this.request<HotelJob>(`/api/hotels/search/${encodeURIComponent(job.id)}`, 'GET', undefined, options.signal);
        if (['success', 'partial', 'unavailable'].includes(current.status)) return current;
        if (['failed', 'cancelled'].includes(current.status)) throw new Error(current.error ?? `Hotel search ${current.status}`);
        await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs ?? 1000));
      }
      throw new Error('Hotel search timed out');
    } catch (error) {
      try { await this.request(`/api/hotels/search/${encodeURIComponent(job.id)}`, 'DELETE'); }
      catch (cancelError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; could not cancel server search ${job.id}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`, { cause: cancelError });
      }
      throw error;
    }
  }
}
