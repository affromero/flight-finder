/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { SearchBar } from './SearchBar';
import type { PreviewRunStatusPayload } from '@/lib/preview-run';

const PREVIEW_RUN_ID = 'pr-test-1';
const PREVIEW_STORAGE_KEY = 'ft-preview-run';
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

function savedPreview(overrides: { startedAt?: number } = {}) {
  return {
    previewRunId: PREVIEW_RUN_ID,
    parsed: {
      origin: 'JFK',
      originName: 'JFK',
      destination: 'LAX',
      destinationName: 'LAX',
      origins: [{ code: 'JFK', name: 'JFK' }],
      destinations: [{ code: 'LAX', name: 'LAX' }],
      dateFrom: '2026-11-09',
      dateTo: '2026-11-13',
      flexibility: 0,
      maxPrice: null,
      maxStops: null,
      maxDurationHours: null,
      preferredAirlines: [],
      timePreference: 'any',
      cabinClass: 'economy',
      tripType: 'one_way',
      currency: 'USD',
    },
    query: 'JFK to LAX November 9 to 13',
    manualRawInput: '',
    vpnCountries: [],
    startedAt: overrides.startedAt ?? Date.now(),
  };
}

function previewResponse(payload: PreviewRunStatusPayload): Response {
  return new Response(JSON.stringify({ ok: true, data: payload }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function configResponse(): Response {
  return new Response(JSON.stringify({ ok: true, data: { defaultCurrency: 'USD', defaultSearchMethod: 'ai' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  // Mute the audio context that playNotificationSound creates.
  vi.stubGlobal('AudioContext', vi.fn(() => ({
    createOscillator: () => ({ connect: vi.fn(), frequency: { setValueAtTime: vi.fn() }, start: vi.fn(), stop: vi.fn() }),
    createGain: () => ({ connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }),
    destination: {},
    currentTime: 0,
  })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SearchBar preview polling', () => {
  it('honors completed status even when the poll cutoff has already passed (ordering invariant for issue #65)', async () => {
    // Set startedAt to epoch so the 30 min cutoff fires on the very
    // first poll. Before the phase 1 fix, the cutoff branch ran before
    // the completed branch and the result was discarded. With the fix,
    // completed wins.
    window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(savedPreview({ startedAt: 0 })));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/admin/config') return configResponse();
      if (url.includes('/api/preview/')) {
        return previewResponse({
          id: PREVIEW_RUN_ID,
          status: 'completed',
          result: {
            routes: [{
              origin: 'JFK',
              originName: 'New York',
              destination: 'LAX',
              destinationName: 'Los Angeles',
              flights: [],
            }],
          },
          error: null,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchBar />);

    // The cutoff error must NOT surface; sessionStorage must be cleared
    // (cleared by the completed branch). Render path goes to FlightPicker.
    await waitFor(() => {
      expect(window.sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull();
    });
    expect(screen.queryByText(/took too long/i)).not.toBeInTheDocument();
  });

  it('honors failed status even when the poll cutoff has already passed (ordering invariant)', async () => {
    window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(savedPreview({ startedAt: 0 })));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/admin/config') return configResponse();
      if (url.includes('/api/preview/')) {
        return previewResponse({
          id: PREVIEW_RUN_ID,
          status: 'failed',
          result: null,
          error: 'No flights found for any route',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchBar />);

    await waitFor(() => {
      expect(screen.queryByText(/No flights found for any route/i)).toBeInTheDocument();
    });
    // The backend supplied error wins over the cutoff message.
    expect(screen.queryByText(/took too long/i)).not.toBeInTheDocument();
  });

  it('fires cutoff error when status is still running past the 30 min window', async () => {
    // startedAt one second past the 30 min window, status stays running.
    const past = Date.now() - POLL_TIMEOUT_MS - 1000;
    window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(savedPreview({ startedAt: past })));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/admin/config') return configResponse();
      if (url.includes('/api/preview/')) {
        return previewResponse({
          id: PREVIEW_RUN_ID,
          status: 'running',
          result: null,
          error: null,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchBar />);

    await waitFor(() => {
      expect(screen.getByText(/took too long/i)).toBeInTheDocument();
    });
  });

  it('keeps polling without firing cutoff when status is running within the window', async () => {
    window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(savedPreview({ startedAt: Date.now() })));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/admin/config') return configResponse();
      if (url.includes('/api/preview/')) {
        return previewResponse({
          id: PREVIEW_RUN_ID,
          status: 'running',
          result: null,
          error: null,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchBar />);

    // Loading state should appear without any error.
    await waitFor(() => {
      expect(screen.getByText(/Searching Google Flights/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/took too long/i)).not.toBeInTheDocument();
    // sessionStorage stays populated (poll loop has not given up).
    expect(window.sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeTruthy();
  });

  it('surfaces the cutoff error from the catch branch on a sustained fetch failure past the window (audit A1)', async () => {
    // Audit A1: previously the catch branch only scheduled another
    // poll without checking the cutoff. A network or JSON error that
    // outlasted the cutoff window would loop forever. With the fix,
    // the catch branch invokes the same cutoff helper as the success
    // path.
    const past = Date.now() - POLL_TIMEOUT_MS - 1000;
    window.sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(savedPreview({ startedAt: past })));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/admin/config') return configResponse();
      if (url.includes('/api/preview/')) {
        // Throw to land in the SearchBar poll's catch branch.
        throw new Error('network down');
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SearchBar />);

    await waitFor(() => {
      expect(screen.getByText(/took too long/i)).toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem(PREVIEW_STORAGE_KEY)).toBeNull();
  });
});
