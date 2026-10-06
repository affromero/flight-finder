import { afterEach, expect, it, vi } from 'vitest';
import { requestFlightParse } from '../client';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('reports uncertainty when admission is cancelled before its private job acknowledgement arrives', async () => {
  let accepted!: () => void;
  const committed = new Promise<void>(resolve => { accepted = resolve; });
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    accepted();
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const controller = new AbortController();
  const promise = requestFlightParse({ query: 'JFK to LAX tomorrow' }, true, controller.signal, () => {});
  const rejected = expect(promise).rejects.toMatchObject({ code: 'cancellation_unconfirmed' });
  await committed;
  controller.abort();
  await rejected;
});
it('bounds an unacknowledged background POST and reports uncertain admission', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const promise = requestFlightParse({ query: 'JFK to LAX tomorrow' }, true, new AbortController().signal, () => {});
  const rejected = expect(promise).rejects.toMatchObject({ code: 'cancellation_unconfirmed' });
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
});
it('bounds a held private status body and cancels the acknowledged job separately', async () => {
  vi.useFakeTimers();
  const requests: { url: string; method?: string }[] = [];
  const job = { id: 'held-body', status: 'queued', expiresAt: '2026-10-07T00:00:00Z' };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method });
    if (url === '/api/parse') return Response.json({ ok: true, data: job }, { status: 202 });
    if (init.method === 'DELETE') return Response.json({ ok: true, data: { ...job, status: 'cancelled' } });
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true,"data":'));
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    } });
    return new Response(stream);
  });
  const promise = requestFlightParse({ query: 'JFK to LAX tomorrow' }, true, new AbortController().signal, () => {});
  const rejected = expect(promise).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(31_000);
  await rejected;
  expect(requests).toContainEqual({ url: '/api/parse/held-body', method: 'DELETE' });
});
