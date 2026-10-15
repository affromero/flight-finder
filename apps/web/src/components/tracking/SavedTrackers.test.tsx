/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedTrackers } from '../SavedTrackers';
import { addSavedTracker } from '@/lib/tracker-storage';

beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe('refreshing a tracker group', () => {
  it('preserves refresh for the existing saved-tracker view when listing requests fail', async () => {
    addSavedTracker({ id: 'saved', origin: 'JFK', originName: 'New York', destination: 'LAX', destinationName: 'Los Angeles',
      dateFrom: '2099-05-03', dateTo: '2099-05-20', createdAt: '2027-01-01T00:00:00Z', deleteToken: 'saved-token' });
    const sent: { path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/scrape') && typeof init?.body === 'string') {
        sent.push({ path, body: JSON.parse(init.body) });
        return Response.json({ ok: true, data: { count: 1 } });
      }
      throw new Error('Listing unavailable');
    });
    render(<SavedTrackers />);
    fireEvent.click(await screen.findByRole('button', { name: /refresh prices/i }));
    await waitFor(() => expect(sent).toEqual([
      { path: '/api/queries/saved/scrape', body: { deleteToken: 'saved-token' } },
    ]));
  });

  it.each(['paused', 'expired'])('uses the live sibling token when the primary is %s', async state => {
    const common = { origin: 'JFK', originName: 'New York', destination: 'LAX', destinationName: 'Los Angeles',
      dateTo: '2099-05-20', createdAt: '2027-01-01T00:00:00Z', scrapeInterval: 3, snapshotCount: 0,
      lastScrapedAt: null, lastScrapeStatus: null, lastScrapeError: null, groupId: 'group', label: null, preferredAggregators: [] };
    const queries = [
      { ...common, id: 'primary', dateFrom: state === 'expired' ? '2000-01-01' : '2099-05-01', active: state !== 'paused' },
      { ...common, id: 'live', dateFrom: '2099-05-03', active: true },
    ];
    for (const query of queries) addSavedTracker({
      id: query.id, origin: query.origin, originName: query.originName,
      destination: query.destination, destinationName: query.destinationName,
      dateFrom: query.dateFrom, dateTo: query.dateTo, createdAt: query.createdAt,
      deleteToken: `${query.id}-token`,
    });
    const sent: { path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/queries/active') return Response.json({ ok: true, data: { queries } });
      if (path.endsWith('/scrape') && typeof init?.body === 'string') {
        sent.push({ path, body: JSON.parse(init.body) });
        return Response.json({ ok: true, data: { count: 1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<SavedTrackers />);
    const refresh = await screen.findByRole('button', { name: /refresh prices/i });
    expect(screen.getAllByRole('link').some(link => link.getAttribute('href') === '/q/primary')).toBe(true);
    fireEvent.click(refresh);
    await waitFor(() => expect(sent).toEqual([
      { path: '/api/queries/live/scrape', body: { deleteToken: 'live-token' } },
    ]));
  });
});
