import type { Dispatcher } from 'undici';

export interface NotificationTransportOptions { signal?: AbortSignal }

interface ResponseOptions {
  accepted?: (response: Response, signal: AbortSignal) => Promise<void>;
  includeErrorDetail?: boolean;
}

/** Provider acknowledgments remain bounded and cancellable through body reads. */
export async function notificationJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Notification provider returned an empty acknowledgment');
  const decoder = new TextDecoder();
  let body = '', bytes = 0;
  try {
    for (;;) {
      const part = await notificationBoundary(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 16_384) throw new Error('Notification provider acknowledgment exceeded its size limit');
      body += decoder.decode(part.value, { stream: true });
    }
    signal.throwIfAborted();
    try { return JSON.parse(body + decoder.decode()) as unknown; }
    catch { throw new Error('Notification provider returned an invalid acknowledgment'); }
  } finally { await reader.cancel(); }
}

/** Cancellation stops waiting for DNS too; callers must check authority before I/O. */
export function notificationBoundary<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

export async function notificationDeadline<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Notification transport deadline exceeded')), 15_000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  try { signal.throwIfAborted(); return await work(signal); }
  finally { clearTimeout(timer); }
}

/** Do not buffer arbitrary provider error pages or leave successful bodies open. */
export async function notificationPost(url: string, init: RequestInit & { dispatcher?: Dispatcher }, name: string, signal: AbortSignal, options: ResponseOptions = {}): Promise<void> {
  signal.throwIfAborted();
  const response = await fetch(url, { ...init, signal });
  if (response.ok) {
    if (options.accepted) await options.accepted(response, signal);
    else await response.body?.cancel();
    return;
  }
  if (options.includeErrorDetail === false) {
    await response.body?.cancel();
    throw new Error(`${name} HTTP ${response.status}`);
  }
  let detail = '';
  const reader = response.body?.getReader();
  try {
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < 1024) {
        const part = await notificationBoundary(reader.read(), signal);
        if (part.done) break;
        const bounded = part.value.subarray(0, 1024 - bytes);
        detail += decoder.decode(bounded, { stream: true }); bytes += bounded.length;
      }
    }
  } finally { await reader?.cancel(); }
  throw new Error(`${name} ${response.status}: ${detail.slice(0, 200)}`);
}
