/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { UpdateBanner } from './UpdateBanner';

function versionResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// jsdom in vitest 4 exposes a partial Storage stub. Replace it with a real
// Map-backed implementation so getItem / setItem / clear all behave.
function installMapStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
  return store;
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    installMapStorage();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when no update and no rename announcement', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      versionResponse({ current: '0.8.0', latest: '0.8.0', updateAvailable: false, renameAnnouncement: null })
    );
    const { container } = render(<UpdateBanner />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders standard update banner when updateAvailable and no rename', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      versionResponse({ current: '0.8.0', latest: '0.8.1', updateAvailable: true, renameAnnouncement: null })
    );
    render(<UpdateBanner />);
    expect(await screen.findByText(/Flight Finder/)).toBeTruthy();
    expect(await screen.findByText(/v0\.8\.1/)).toBeTruthy();
    expect(await screen.findByText('flight-finder update')).toBeTruthy();
  });

  it('renders the rename variant when renameAnnouncement is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      versionResponse({
        current: '0.7.4',
        latest: '0.8.0',
        updateAvailable: true,
        renameAnnouncement: {
          from: 'Fairtrail',
          to: 'Flight Finder',
          upgradeCommand: 'fairtrail update',
        },
      })
    );
    render(<UpdateBanner />);
    expect(await screen.findByText(/Renamed to/)).toBeTruthy();
    expect(await screen.findByText('fairtrail update')).toBeTruthy();
    expect(screen.queryByText(/is available/)).toBeNull();
  });

  it('suppresses the rename banner after dismissal', async () => {
    window.localStorage.setItem('ft-rename-banner-dismissed-0.8.0', '1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      versionResponse({
        current: '0.7.4',
        latest: '0.8.0',
        updateAvailable: true,
        renameAnnouncement: {
          from: 'Fairtrail',
          to: 'Flight Finder',
          upgradeCommand: 'fairtrail update',
        },
      })
    );
    const { container } = render(<UpdateBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it('dismiss button writes localStorage and hides the banner', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      versionResponse({
        current: '0.7.4',
        latest: '0.8.0',
        updateAvailable: true,
        renameAnnouncement: {
          from: 'Fairtrail',
          to: 'Flight Finder',
          upgradeCommand: 'fairtrail update',
        },
      })
    );
    render(<UpdateBanner />);
    const dismissBtn = await screen.findByLabelText('Dismiss');
    act(() => {
      dismissBtn.click();
    });
    await waitFor(() => {
      expect(screen.queryByText(/Renamed to/)).toBeNull();
    });
    expect(window.localStorage.getItem('ft-rename-banner-dismissed-0.8.0')).toBe('1');
  });
});
