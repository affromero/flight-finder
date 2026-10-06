/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en/components.json';
import { TrackerNotifications } from './TrackerNotifications';

vi.unmock('next-intl');

function renderControls() {
  return render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><TrackerNotifications queryId="tracker" canEdit /></NextIntlClientProvider>);
}

const settings = { mode: 'inherit', channelIds: [], revision: 0, channels: [{ id: 'one', label: 'Household phone', type: 'telegram', enabled: true }] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('tracker notification controls', () => {
  it('loads default routing and saves an explicit selected recipient', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/queries/tracker/notifications');
      if (init?.method === 'PATCH') {
        const request: unknown = JSON.parse(String(init.body)); requests.push(request);
        return Response.json({ ok: true, data: { settings: { ...settings, mode: 'selected', channelIds: ['one'], revision: 1 } } });
      }
      return Response.json({ ok: true, data: { settings } });
    });
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    const recipients = await screen.findByRole('combobox', { name: 'Notification recipients' });
    expect(recipients).toHaveValue('inherit');
    fireEvent.change(recipients, { target: { value: 'selected' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Household phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
    expect(requests).toEqual([{ mode: 'selected', channelIds: ['one'], revision: 0, deleteToken: null }]);
  });
  it('surfaces a loading failure without presenting default settings as a successful response', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: false, error: 'Server unavailable' }, { status: 503 }));
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('lets users remove unavailable selected channels before saving', async () => {
    let saved: unknown;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/queries/tracker/notifications');
      if (init?.method === 'PATCH') saved = JSON.parse(String(init.body));
      return Response.json({ ok: true, data: { settings: { ...settings, mode: 'selected', channelIds: ['removed'], revision: 2 } } });
    });
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable channels' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Household phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ mode: 'selected', channelIds: ['one'], revision: 2 }));
  });
});
