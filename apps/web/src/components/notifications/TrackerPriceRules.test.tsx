/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en/components.json';
import { TrackerPriceRules } from './TrackerPriceRules';

vi.unmock('next-intl');
const rule = { id: 'rule-one', flightId: null, currency: 'USD', targetPrice: 150, dropAbs: null, dropPct: null, enabled: true, cooldownMinutes: 0 };
const settings = { revision: 0, rules: [], currency: 'USD', fixedCurrency: null,
  flights: [{ id: 'FA100', label: 'Fixture Air FA100', currency: 'USD', price: 200 }] };
const response = (value: object) => Response.json({ ok: true, data: { settings: value } });
function controls(canEdit = true) {
  render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><TrackerPriceRules queryId="tracker" canEdit={canEdit} /></NextIntlClientProvider>);
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Price alerts' }));
  await screen.findByRole('button', { name: 'Add rule' });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('tracker price rule controls', () => {
  it('converts an edited percentage into a fraction and saves an independent flight rule', async () => {
    let saved: unknown;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/queries/tracker/alerts');
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return response(settings);
    });
    controls(); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Apply to' }), { target: { value: JSON.stringify(['FA100', 'USD']) } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Drop (%)' }), { target: { value: '10' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Cooldown (minutes)' }), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ revision: 0, deleteToken: null, rules: [{ flightId: 'FA100', currency: 'USD',
      dropPct: 0.1, targetPrice: null, dropAbs: null, enabled: true, cooldownMinutes: 30 }] }));
  });
  it('preserves an untouched fractional threshold exactly when saving', async () => {
    const original = { ...rule, targetPrice: null, dropPct: Number('0.12345678901234567') };
    let saved: { rules: unknown[] } | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return response({ ...settings, rules: [original], revision: 7 });
    });
    controls(); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved?.rules).toEqual([original]));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
  it('allows an unavailable stored flight to be paused without losing its scope', async () => {
    let saved: unknown;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return response({ ...settings, rules: [{ ...rule, flightId: 'unavailable' }] });
    });
    controls(); await open();
    expect(screen.getByRole('combobox')).toHaveDisplayValue('Previously selected flight (USD)');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ rules: [{ ...rule, flightId: 'unavailable', enabled: false }] }));
  });
  it('lets a tracker-wide rule choose an explicit currency before any identifiable fares exist', async () => {
    let saved: unknown;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return response({ ...settings, currency: null, flights: [] });
    });
    controls(); await open(); fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Currency' }), { target: { value: 'eur' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ rules: [{ currency: 'EUR', flightId: null, targetPrice: 100 }] }));
  });
  it('keeps a stale draft visible and reloads the current collection after a conflict', async () => {
    let current = { ...settings, revision: 1, rules: [rule] };
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        current = { ...current, revision: 2, rules: [{ ...rule, targetPrice: 80 }] };
        return Response.json({ ok: false, error: 'Price rules changed. Reload before saving.' }, { status: 409 });
      }
      return response(current);
    });
    controls(); await open();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Reload/);
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toHaveValue(120);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Target price' })).toHaveValue(80));
  });
  it('rejects a 100 percent drop and removes a rule through the full collection update', async () => {
    let saved: unknown;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return response({ ...settings, rules: [rule] });
    });
    controls(); await open();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Drop (%)' }), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/below 100/);
    expect(saved).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ rules: [] }));
  });
  it('surfaces a loading failure without rendering empty settings', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: false, error: 'Server unavailable' }, { status: 503 }));
    controls(); fireEvent.click(screen.getByRole('button', { name: 'Price alerts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });
  it('rebinds an old flight to a changed tracker currency only after an explicit choice', async () => {
    let saved: unknown;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return response({ ...settings, fixedCurrency: 'EUR', rules: [{ ...rule, flightId: 'FA100' }] });
    });
    controls(); await open();
    expect(screen.getByRole('combobox')).toHaveDisplayValue('Previously selected flight (USD)');
    expect(screen.getByRole('alert')).toHaveTextContent(/EUR/);
    fireEvent.click(screen.getByRole('button', { name: 'Use tracker currency' }));
    expect(screen.getByRole('textbox', { name: 'Currency' })).toHaveValue('EUR');
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toHaveValue(null);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ rules: [{ ...rule, flightId: null, currency: 'EUR', targetPrice: 120 }] }));
  });
  it.each(['reload', 'save'])('keeps the active panel in place during a delayed %s response', async action => {
    let finish: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (action === 'save' && init?.method === 'PUT' || action === 'reload' && finish === undefined && screen.queryByRole('button', { name: 'Add rule' })) {
        return new Promise<Response>(resolve => { finish = resolve; });
      }
      return response(settings);
    });
    controls(); await open();
    fireEvent.click(screen.getByRole('button', { name: action === 'save' ? 'Save' : 'Reload' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Price alerts' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(finish).toBeDefined(); finish!(response({ ...settings, revision: 3 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Price alerts' })).toBeEnabled());
    if (action === 'reload') expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    else expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
  it('waits for fresh settings before presenting a reopened editor', async () => {
    let firstRead = true, finish: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return response({ ...settings, rules: [rule] });
      if (firstRead) { firstRead = false; return response({ ...settings, rules: [rule] }); }
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    controls(); await open(); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Price alerts' }));
    expect(screen.queryByRole('spinbutton', { name: 'Target price' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    finish!(response({ ...settings, revision: 4, rules: [{ ...rule, targetPrice: 80 }] }));
    expect(await screen.findByRole('spinbutton', { name: 'Target price' })).toHaveValue(80);
  });
  it('uses a saved capability for reading and updating a tracker while hiding controls from other viewers', async () => {
    controls(false); expect(screen.queryByRole('button')).not.toBeInTheDocument(); cleanup();
    localStorage.setItem('ft-trackers', JSON.stringify([{ id: 'tracker', deleteToken: 'capability' }]));
    let saved: unknown, readHeaders: HeadersInit | undefined;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body)); else readHeaders = init?.headers;
      return response(settings);
    });
    controls(false); await open();
    expect(readHeaders).toEqual({ 'x-delete-token': 'capability' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ deleteToken: 'capability', rules: [] }));
  });
});
