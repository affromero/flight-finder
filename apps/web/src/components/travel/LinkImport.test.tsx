/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkImport } from './LinkImport';
import { FLIGHT_IMPORT_URL } from '@/test/import-fixtures';
import { flightLinkQuery } from '@/lib/scraper/flight-link';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('pasting a selected booking link', () => {
  it('imports details for review without creating a tracker or starting a scrape', async () => {
    const drafts: unknown[] = [], requests: string[] = [];
    const result = { kind: 'flights', url: FLIGHT_IMPORT_URL, flight: flightLinkQuery(FLIGHT_IMPORT_URL) };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return new Response(JSON.stringify({ ok: true, data: result })); }));
    render(<LinkImport kind="flights" disabled={false} onImport={draft => drafts.push(draft)} onClear={() => drafts.splice(0)} />);
    fireEvent.change(screen.getByLabelText('Already picked one? Paste its link'), { target: { value: FLIGHT_IMPORT_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Import link' }));
    await waitFor(() => expect(drafts).toEqual([result]));
    expect(requests).toEqual(['/api/travel/import']);
  });
  it('surfaces unsupported links without applying a replacement draft', async () => {
    const drafts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'This hotel link is not supported' }), { status: 400 })));
    render(<LinkImport kind="hotels" disabled={false} onImport={draft => drafts.push(draft)} onClear={() => drafts.splice(0)} />);
    fireEvent.change(screen.getByLabelText('Already picked one? Paste its link'), { target: { value: 'https://example.com/hotel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not supported/);
    expect(drafts).toEqual([]);
    expect(screen.getByRole('button', { name: 'Import link' })).toBeEnabled();
  });
  it('releases the form after a stalled import request times out', async () => {
    vi.useFakeTimers();
    const drafts: unknown[] = [], busy: boolean[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise((resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); })));
    render(<LinkImport kind="cars" disabled={false} onBusy={value => busy.push(value)} onImport={draft => drafts.push(draft)} onClear={() => drafts.splice(0)} />);
    fireEvent.change(screen.getByLabelText('Already picked one? Paste its link'), { target: { value: 'https://book.autoeurope.com/en-us/options?rate_reference=old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import link' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not import/);
    expect(busy.at(-1)).toBe(false);
    expect(drafts).toEqual([]);
    expect(screen.getByRole('button', { name: 'Import link' })).toBeEnabled();
  });
});
