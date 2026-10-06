import type { ParseInput } from './input';
import type { ParseJobStatus } from './types';
import type { ParseResponse } from '../scraper/parse-query';
import type { ApiResponse } from '../api-response';

export class ParseClientError extends Error {
  constructor(readonly code: string) { super(code); }
}

type ParseTransport = (path: string, init: RequestInit) => Promise<Response>;

async function cancelJob(job: ParseJobStatus, transport: ParseTransport): Promise<void> {
  try {
    const cancelled = await transport(`/api/parse/${encodeURIComponent(job.id)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(5000),
      headers: job.capability ? { 'X-Parse-Capability': job.capability } : {},
    });
    if (!cancelled.ok) throw new ParseClientError('cancellation_unconfirmed');
  } catch { throw new ParseClientError('cancellation_unconfirmed'); }
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function parseRequest<T>(transport: ParseTransport, url: string, init: RequestInit, signal: AbortSignal, deadline?: number): Promise<{ status: number; body: ApiResponse<T> }> {
  const timeout = new AbortController();
  const remaining = deadline === undefined ? undefined : Math.min(30_000, deadline - Date.now());
  if (remaining !== undefined && remaining <= 0) throw new ParseClientError('timeout');
  const timer = remaining === undefined ? undefined : setTimeout(() => timeout.abort(new ParseClientError('timeout')), remaining);
  try {
    const response = await transport(url, { ...init, signal: AbortSignal.any([signal, timeout.signal]) });
    const body = await response.json() as ApiResponse<T>;
    return { status: response.status, body };
  } finally { clearTimeout(timer); }
}

export async function requestFlightParse(input: ParseInput, background: boolean, signal: AbortSignal, onJob: (job: ParseJobStatus | null) => void, transport: ParseTransport = fetch): Promise<ApiResponse<ParseResponse>> {
  let job: ParseJobStatus | null = null;
  let terminal = false;
  const deadline = Date.now() + 22 * 60 * 1000;
  try {
    const response = await parseRequest<ParseResponse | ParseJobStatus>(transport, '/api/parse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, ...(background ? { mode: 'async' } : {}) }),
    }, signal, background ? deadline : undefined);
    const { body } = response;
    if (!body.ok) return body;
    if (!background) return body as ApiResponse<ParseResponse>;
    if (response.status !== 202 || !('id' in body.data) || typeof body.data.id !== 'string') throw new ParseClientError('invalid_status');
    job = body.data;
    onJob(job);
    for (;;) {
      signal.throwIfAborted();
      if (job.status === 'completed' && job.result) { terminal = true; return { ok: true, data: job.result }; }
      if (job.status === 'failed' || job.status === 'cancelled') { terminal = true; throw new ParseClientError(job.error ?? job.status); }
      if (!['queued', 'running'].includes(job.status)) throw new ParseClientError('invalid_status');
      if (Date.now() >= deadline) throw new ParseClientError('timeout');
      await pause(signal);
      const next: ApiResponse<ParseJobStatus> = (await parseRequest<ParseJobStatus>(transport, `/api/parse/${encodeURIComponent(job.id)}`, {
        cache: 'no-store', headers: job.capability ? { 'X-Parse-Capability': job.capability } : {},
      }, signal, deadline)).body;
      if (!next.ok) return next;
      if (next.data.id !== job.id) throw new ParseClientError('invalid_status');
      job = { ...next.data, capability: job.capability };
      onJob(job);
    }
  } catch (error) {
    if (background && !job && (signal.aborted || error instanceof ParseClientError && error.code === 'timeout'))
      throw new ParseClientError('cancellation_unconfirmed');
    throw error;
  } finally {
    onJob(null);
    if (job && !terminal) {
      // Cancellation has its own bounded request after the polling signal stops.
      await cancelJob(job, transport);
    }
  }
}
