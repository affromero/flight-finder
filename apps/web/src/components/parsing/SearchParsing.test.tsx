/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SearchBar } from '../SearchBar';

const result = { parsed: null, confidence: 'medium', ambiguities: [{ field: 'date', question: 'Which departure date?', options: ['Friday', 'Saturday'] }], dateSpanDays: 0 };
const job = { id: 'private-parse', status: 'queued', expiresAt: '2026-10-07T00:00:00Z', capability: 'a'.repeat(64) };
function success(data: unknown, status = 200) { return Response.json({ ok: true, data }, { status }); }
const requests: { path: string; init?: RequestInit }[] = [];
beforeEach(() => { requests.length = 0; window.sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function boundary(parse: (path: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', async (value: RequestInfo | URL, init?: RequestInit) => {
    const path = String(value); requests.push({ path, init });
    if (path === '/api/admin/config') return success({ defaultSearchMethod: 'ai' });
    if (path === '/api/preview') return success({ previewMaxCombos: 24 });
    return parse(path, init);
  });
}
function submit(background = false) {
  render(<SearchBar />);
  if (background) fireEvent.click(screen.getByRole('checkbox', { name: 'Parse in the background' }));
  const input = screen.getByPlaceholderText('NYC to Paris around June 15 +/- 3 days');
  fireEvent.change(input, { target: { value: 'JFK to LAX tomorrow' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}
it('keeps synchronous parsing as the default and renders the canonical clarification', async () => {
  boundary(() => success(result));
  submit();
  expect(await screen.findByRole('group', { name: 'Which departure date?' })).toBeVisible();
  const request = requests.find(request => request.path === '/api/parse');
  expect(JSON.parse(String(request?.init?.body))).toMatchObject({ query: 'JFK to LAX tomorrow' });
  expect(JSON.parse(String(request?.init?.body))).not.toHaveProperty('mode');
  expect(screen.getByRole('checkbox', { name: 'Parse in the background' })).not.toBeChecked();
});
it('polls a private background job and renders its clarification without changing the search flow', async () => {
  boundary(path => path === '/api/parse' ? success(job, 202) : success({ ...job, status: 'completed', result }));
  submit(true);
  expect(await screen.findByRole('status')).toHaveTextContent('Waiting');
  expect(await screen.findByRole('group', { name: 'Which departure date?' }, { timeout: 3000 })).toBeVisible();
  expect(JSON.parse(String(requests.find(request => request.path === '/api/parse')?.init?.body))).toMatchObject({ mode: 'async' });
  const status = requests.find(request => request.path === '/api/parse/private-parse');
  expect(new Headers(status?.init?.headers).get('X-Parse-Capability')).toBe(job.capability);
  expect(status?.init?.cache).toBe('no-store');
  expect(screen.queryByRole('button', { name: 'Cancel parsing' })).not.toBeInTheDocument();
});
it('cancels background parsing and releases the input after a bounded private DELETE', async () => {
  boundary((path, init) => path === '/api/parse' ? success(job, 202) : success({ ...job, status: init?.method === 'DELETE' ? 'cancelled' : 'running' }));
  const input = submit(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel parsing' }));
  expect(await screen.findByText('Parsing cancelled.')).toBeVisible();
  expect(input).toBeEnabled();
  expect(requests.find(request => request.init?.method === 'DELETE')?.path).toBe('/api/parse/private-parse');
  expect(screen.queryByText('Which departure date?')).not.toBeInTheDocument();
});
it('surfaces a denied private job without starting synchronous fallback', async () => {
  boundary((path, init) => path === '/api/parse' ? success(job, 202) : init?.method === 'DELETE' ? success({ ...job, status: 'cancelled' }) : Response.json({ ok: false, error: 'Parse job not found' }, { status: 404 }));
  const input = submit(true);
  expect(await screen.findByText('Parse job not found', {}, { timeout: 3000 })).toBeVisible();
  expect(input).toBeEnabled();
  expect(requests.filter(request => request.path === '/api/parse')).toHaveLength(1);
});
it('surfaces interrupted work without accepting a provider result', async () => {
  boundary(path => path === '/api/parse' ? success(job, 202) : success({ ...job, status: 'failed', error: 'worker_interrupted', result }));
  const input = submit(true);
  expect(await screen.findByText(/Background parsing stopped/, {}, { timeout: 3000 })).toBeVisible();
  expect(input).toBeEnabled();
  expect(screen.queryByText('Which departure date?')).not.toBeInTheDocument();
});
it('cancels an acknowledged private job when its search component unmounts', async () => {
  boundary(path => path === '/api/parse' ? success(job, 202) : success({ ...job, status: 'cancelled' }));
  submit(true);
  await screen.findByRole('status');
  cleanup();
  await waitFor(() => expect(requests.some(request => request.path === '/api/parse/private-parse' && request.init?.method === 'DELETE')).toBe(true));
});
it('reports an unconfirmed cancellation when the server rejects DELETE', async () => {
  boundary((path, init) => path === '/api/parse' ? success(job, 202) : init?.method === 'DELETE' ? Response.json({ ok: false, error: 'Unavailable' }, { status: 503 }) : success({ ...job, status: 'running' }));
  const input = submit(true);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel parsing' }));
  expect(await screen.findByText(/Could not confirm cancellation/)).toBeVisible();
  expect(input).toBeEnabled();
  expect(screen.queryByText('Parsing cancelled.')).not.toBeInTheDocument();
});
