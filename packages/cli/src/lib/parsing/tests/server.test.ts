import { createServer, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { parseCliFlight } from '../runner.js';
import { parseServerTransport } from '../server.js';
import { CliParseSession } from '../session.js';

const result = { parsed: null, confidence: 'low', ambiguities: [{ field: 'date', question: 'Which date?' }], dateSpanDays: 0 };
const job = { id: 'server-job', status: 'queued', capability: 'a'.repeat(64), expiresAt: '2026-10-07T00:00:00Z' };
const requests: { path: string; method: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];
let origin = '', held = false, denied = false, invalid = false, redirect = false;
const pending: ServerResponse[] = [];
const server = createServer(async (request, response) => {
  let bytes = ''; for await (const chunk of request) bytes += String(chunk);
  requests.push({ path: request.url!, method: request.method!, headers: request.headers, body: bytes ? JSON.parse(bytes) : undefined });
  response.setHeader('content-type', 'application/json');
  if (redirect) { response.writeHead(307, { Location: '/unrelated' }); response.end(); return; }
  if (invalid) { response.end('not JSON'); return; }
  if (request.method === 'DELETE') { response.end(JSON.stringify({ ok: true, data: { ...job, status: 'cancelled' } })); return; }
  if (denied) { response.writeHead(401); response.end(JSON.stringify({ ok: false, error: 'Unauthorized' })); return; }
  if (request.method === 'POST') {
    const async = (requests.at(-1)!.body as { mode?: string }).mode === 'async';
    response.writeHead(async ? 202 : 200); response.end(JSON.stringify({ ok: true, data: async ? job : result })); return;
  }
  if (held) { pending.push(response); return; }
  response.end(JSON.stringify({ ok: true, data: { ...job, status: 'completed', result } }));
});
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port'); origin = `http://127.0.0.1:${address.port}`; });
beforeEach(() => { requests.length = 0; held = false; denied = false; invalid = false; redirect = false; });
afterEach(() => { for (const response of pending.splice(0)) response.destroy(); vi.unstubAllEnvs(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

it('keeps server parsing synchronous by default without opening a local database', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/unavailable');
  expect(await parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'sync', server: origin }, new AbortController().signal)).toMatchObject(result);
  expect(requests[0]!.body).not.toHaveProperty('mode');
});
it('polls a private server job with the existing session, bearer and returned capability', async () => {
  vi.stubEnv('FLIGHT_FINDER_SESSION', 'session-fixture'); vi.stubEnv('FLIGHT_FINDER_TOKEN', 'device-fixture');
  expect(await parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'async', server: origin }, new AbortController().signal)).toMatchObject(result);
  expect(requests[0]!.body).toMatchObject({ mode: 'async' });
  expect(requests.find(request => request.method === 'GET')!.headers).toMatchObject({ cookie: 'ft-session=session-fixture', authorization: 'Bearer device-fixture', origin, 'x-parse-capability': job.capability });
});
it('cancels an acknowledged server job when its abort signal stops polling', async () => {
  held = true;
  const controller = new AbortController();
  const promise = parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'async', server: origin }, controller.signal);
  const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(requests.some(request => request.method === 'GET')).toBe(true), { timeout: 3000 });
  controller.abort(); await rejected;
  expect(requests.find(request => request.method === 'DELETE')!.headers['x-parse-capability']).toBe(job.capability);
});
it('surfaces authorization and malformed responses without retrying locally', async () => {
  denied = true;
  await expect(parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'async', server: origin }, new AbortController().signal)).rejects.toThrow('Unauthorized');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  invalid = true; denied = false;
  await expect(parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'async', server: origin }, new AbortController().signal)).rejects.toBeInstanceOf(SyntaxError);
});
it('rejects redirects before forwarding session credentials to another path', async () => {
  redirect = true;
  await expect(parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'sync', server: origin }, new AbortController().signal)).rejects.toThrow();
  expect(requests.some(request => request.path === '/unrelated')).toBe(false);
});
it('cancels one interactive request without stopping the next request in its session', async () => {
  held = true;
  const session = new CliParseSession({ mode: 'async', server: origin });
  const first = new AbortController();
  const task = session.run('JFK to LAX tomorrow', undefined, first.signal, () => {});
  const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(requests.some(request => request.method === 'GET')).toBe(true), { timeout: 3000 });
  first.abort(); await rejected;
  held = false;
  expect(await session.run('JFK to LAX Friday', undefined, new AbortController().signal, () => {})).toMatchObject(result);
  expect(requests.some(request => request.method === 'DELETE')).toBe(true);
  await session.stop();
});
it.each(['sample-secret\r\nextra', 'sample-secret\x01extra', 'sample-secret\u2603'])('rejects invalid bearer credentials without exposing their values: %j', token => {
  vi.stubEnv('FLIGHT_FINDER_TOKEN', token);
  try { parseServerTransport(origin); throw Error('Expected rejection'); }
  catch (error) { expect(String(error)).toContain('FLIGHT_FINDER_TOKEN'); expect(String(error)).not.toContain('sample-secret'); }
});
it('rejects a completed server result when cancellation arrives before acceptance', async () => {
  const controller = new AbortController();
  await expect(parseCliFlight('JFK to LAX tomorrow', undefined, { mode: 'async', server: origin }, controller.signal,
    job => { if (job?.status === 'completed') controller.abort(); })).rejects.toMatchObject({ name: 'AbortError' });
});
it.each(['ftp://finder.example', 'https://finder.example/path', 'https://user:secret@finder.example', 'https://*.example', 'https://finder.example?query=1'])('rejects an invalid server origin: %s', server => {
  expect(() => parseServerTransport(server)).toThrow();
});
