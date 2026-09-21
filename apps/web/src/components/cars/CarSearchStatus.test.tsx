/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carReportFixture, carSearchFixture } from '@/test/car-fixtures';
import type { CarRunView } from '@/lib/cars/run-view';
import { CAR_STATUS_TIMEOUT_MS, CarSearchStatus } from './CarSearchStatus';
import en from '../../../messages/en/cars.json';
import { TRAVEL_ACCESS_LOST_EVENT } from '../travel/client';

vi.unmock('next-intl');
function initial(status: CarRunView['status'] = 'running'): CarRunView {
  const now = new Date().toISOString();
  return { id: 'search-one', trackerId: null, trackingClosed: false, status, createdAt: now, completedAt: status === 'running' ? null : now, search: carSearchFixture(), result: status === 'running' ? null : carReportFixture(), error: null };
}
function surface(value: CarRunView) {
  return <NextIntlClientProvider locale="en" messages={en}><CarSearchStatus initial={value} actorScope="alice" /></NextIntlClientProvider>;
}
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

describe('private rental result lifecycle', () => {
  it('shows worker recovery guidance and completes the same search after an explicit retry', async () => {
    const value = initial(); let paused = true;
    const message = 'Travel searches are paused. Open /admin for recovery, then retry status.';
    vi.stubGlobal('fetch', vi.fn(async () => paused
      ? new Response(JSON.stringify({ ok: false, error: message }), { status: 503 })
      : response({ ...value, status: 'success', completedAt: value.createdAt, result: carReportFixture() })));
    render(surface(value)); await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Cancel search' })).toBeEnabled();
    paused = false; fireEvent.click(screen.getByRole('button', { name: 'Retry status updates' })); await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeEnabled();
  });
  it('does not treat a malformed 503 page as confirmed recovery guidance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Proxy unavailable</html>', { status: 503 })));
    render(surface(initial())); await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.statusInterrupted);
  });
  it('does not reopen tracking when a stale status response omits an acknowledged permanent closure', async () => {
    const value = { ...initial('success'), trackingClosed: true };
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...value, trackingClosed: false })));
    render(surface(value)); fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.statusInterrupted);
    expect(screen.getByRole('heading', { name: en.Cars.trackingClosed })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeDisabled();
  });
  it.each([401, 403, 404])('hides private results after closure loses access with HTTP %i and retains recovery data', async status => {
    sessionStorage.setItem('ff-car-creation:alice:search-one', '{');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Unavailable</html>', { status })));
    render(surface(initial('success')));
    fireEvent.click(screen.getByText(en.Cars.closeTrackingTitle));
    fireEvent.click(screen.getByRole('button', { name: en.Cars.closeTrackingConfirm })); await settle();
    expect(screen.queryByRole('heading', { name: /Example car/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.Cars.signIn })).toBeInTheDocument();
    expect(sessionStorage.getItem('ff-car-creation:alice:search-one')).toBe('{');
  });
  it.each([401, 403, 404])('hides results and keeps creation recovery after a malformed HTTP %i acknowledgement', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Unavailable</html>', { status })));
    render(surface(initial('success')));
    fireEvent.click(screen.getByRole('button', { name: 'Track this rental' })); await settle();
    expect(screen.queryByRole('heading', { name: /Example car/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.accessLost);
    expect(screen.queryByRole('button', { name: 'Track this rental' })).not.toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('ff-car-creation:alice:search-one')!).body.searchId).toBe('search-one');
  });
  it.each(['poll', 'cancel'])('ignores late %s responses after access loss and requires a fresh authorized read', async operation => {
    const value = initial(operation === 'poll' ? 'success' : 'running');
    let finish!: (value: Response) => void; let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      signal = options.signal; return new Promise<Response>(resolve => { finish = resolve; });
    }));
    render(surface(value));
    fireEvent.click(screen.getByRole('button', { name: operation === 'poll' ? 'Refresh status' : 'Cancel search' }));
    act(() => window.dispatchEvent(new Event(TRAVEL_ACCESS_LOST_EVENT)));
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish(response(operation === 'poll' ? value : { id: value.id, status: 'cancelled' })); });
    expect(screen.queryByRole('heading', { name: /Example car/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.Cars.signIn })).toBeInTheDocument();
    vi.stubGlobal('fetch', vi.fn(async () => response(value)));
    fireEvent.click(screen.getByRole('button', { name: 'Retry status updates' })); await settle();
    expect(screen.queryByRole('link', { name: en.Cars.signIn })).not.toBeInTheDocument();
  });
  it('continues polling when provider locations resolve without changing the requested rental', async () => {
    const value = initial();
    value.search.pickup = { ...value.search.pickup, catalog: { id: 'ourairports:2434', version: 'a'.repeat(64) }, providerIds: {} };
    value.search.dropoff = { ...value.search.pickup };
    const next = structuredClone(value);
    next.search.pickup.providerIds = { discovercars: '1712', autoeurope: '547' };
    next.search.dropoff.providerIds = { ...next.search.pickup.providerIds };
    next.search.pickup.providerNames = { discovercars: 'London Airport Heathrow (LHR)' };
    vi.stubGlobal('fetch', vi.fn(async () => response(next)));
    render(surface(value)); await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel search' })).toBeEnabled();
  });
  it('hides private results when an expired session returns an HTML login response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in</html>', { status: 401 })));
    render(surface(initial('success'))); fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await settle();
    expect(screen.queryByRole('heading', { name: /Example car/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.accessLost);
  });
  it('polls until completion and makes the verified result trackable without further automatic requests', async () => {
    const value = initial(), done = { ...value, status: 'success', completedAt: value.createdAt, result: carReportFixture() };
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return response(done); }));
    render(surface(value)); await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel search' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(requests).toEqual(['/api/cars/search/search-one']);
  });
  it('retains interrupted results as read-only and restores tracking after an explicit successful retry', async () => {
    const value = initial('success'); let interrupted = true;
    vi.stubGlobal('fetch', vi.fn(async () => { if (interrupted) throw new TypeError('Offline'); return response(value); }));
    render(surface(value)); fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.statusInterrupted);
    expect(screen.getByRole('heading', { name: /Example car/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeDisabled();
    interrupted = false; fireEvent.click(screen.getByRole('button', { name: 'Retry status updates' })); await settle();
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeEnabled();
  });
  it.each([401, 403, 404])('hides private results after access is lost with HTTP %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Access denied' }), { status })));
    render(surface(initial('success'))); fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await settle();
    expect(screen.queryByRole('heading', { name: /Example car/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.accessLost);
    expect(screen.getByRole('link', { name: en.Cars.signIn })).toHaveAttribute('href', '/login?next=%2Fcars%2Fsearch%2Fsearch-one');
  });
  it('allows cancellation during a stalled poll and ignores its late response', async () => {
    const value = initial(); let finishPoll: ((value: Response) => void) | undefined;
    const requests: string[] = []; let pollSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      requests.push(options.method ?? 'GET');
      if (requests.length === 1) { pollSignal = options.signal; return new Promise<Response>(resolve => { finishPoll = resolve; }); }
      if (options.method === 'DELETE') return response({ id: value.id, status: 'cancelled' });
      return response({ ...value, status: 'cancelled', completedAt: value.createdAt });
    }));
    render(surface(value)); await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel search' })); await settle();
    expect(pollSignal?.aborted).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent(en.Cars.cancelled);
    await act(async () => { finishPoll?.(response({ ...value, status: 'success', completedAt: value.createdAt, result: carReportFixture() })); });
    expect(screen.getByRole('status')).toHaveTextContent(en.Cars.cancelled);
    expect(requests).toEqual(['GET', 'DELETE', 'GET']);
  });
  it('keeps private results hidden after a failed access-recovery attempt until authorization succeeds', async () => {
    const value = initial('success'); let outcome = 'denied';
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (outcome === 'offline') throw new TypeError('Offline');
      return outcome === 'denied' ? new Response(JSON.stringify({ ok: false, error: 'Access denied' }), { status: 401 }) : response(value);
    }));
    render(surface(value)); fireEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await settle();
    outcome = 'offline'; fireEvent.click(screen.getByRole('button', { name: 'Retry status updates' })); await settle();
    expect(screen.queryByRole('heading', { name: /Example car/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.Cars.signIn })).toBeInTheDocument();
    outcome = 'authorized'; fireEvent.click(screen.getByRole('button', { name: 'Retry status updates' })); await settle();
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeEnabled();
  });
  it('shows the completed result if completion won the cancellation race', async () => {
    const value = initial();
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => response(options.method === 'DELETE' ? { id: value.id, status: 'success' } : { ...value, status: 'success', completedAt: value.createdAt, result: carReportFixture() })));
    render(surface(value)); fireEvent.click(screen.getByRole('button', { name: 'Cancel search' })); await settle();
    expect(screen.getByRole('button', { name: 'Track this rental' })).toBeEnabled();
  });
  it('aborts a pending poll when the result page is unmounted', async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => { signal = options.signal; return new Promise<Response>((resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); }));
    const view = render(surface(initial())); await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    view.unmount(); expect(signal?.aborted).toBe(true); await settle();
  });
  it('stops automatic polling after its deadline and offers an explicit retry', async () => {
    let signal: AbortSignal | null | undefined; const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      requests.push(url); signal = options.signal;
      return new Promise<Response>((resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
    }));
    render(surface(initial())); await act(async () => { await vi.advanceTimersByTimeAsync(1500 + CAR_STATUS_TIMEOUT_MS); });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.statusInterrupted);
    expect(screen.getByRole('button', { name: 'Retry status updates' })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(requests).toEqual(['/api/cars/search/search-one']);
  });
  it('does not claim cancellation when the acknowledgement is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Lost response'); }));
    render(surface(initial())); fireEvent.click(screen.getByRole('button', { name: 'Cancel search' })); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.cancelUncertain);
    expect(screen.getByRole('button', { name: 'Retry status updates' })).toBeEnabled();
    expect(screen.queryByText(en.Cars.cancelled)).not.toBeInTheDocument();
  });
});
