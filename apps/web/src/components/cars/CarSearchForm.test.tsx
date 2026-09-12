/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarSearchForm } from './CarSearchForm';
import type { CarLocationChoice } from '@/lib/cars/location-types';
import { carFormOptions } from '@/lib/cars/form-options';
import en from '../../../messages/en/cars.json';
import es from '../../../messages/es/cars.json';
import pt from '../../../messages/pt/cars.json';
import fr from '../../../messages/fr/cars.json';
import de from '../../../messages/de/cars.json';
import common from '../../../messages/en/common.json';
import { CAR_IMPORT_URL } from '@/test/import-fixtures';
import { validateCarParseDraft } from '@/lib/cars/parse-draft';

vi.unmock('next-intl');
const place: CarLocationChoice = { id: 'ourairports:2434', version: 'a'.repeat(64), name: 'London Heathrow Airport', kind: 'airport', city: 'London', country: 'GB', region: 'England', timeZone: 'Europe/London', latitude: 51.47, longitude: -.45, iata: 'LHR' };
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
const surface = (locale = 'en', messages = en) => <NextIntlClientProvider locale={locale} messages={{ ...messages, LinkImport: common.LinkImport }}><CarSearchForm actorScope="alice" defaultCurrency="GBP" defaultSources={['discovercars', 'autoeurope']} options={carFormOptions(locale)} /></NextIntlClientProvider>;
beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
async function completeForm(copy = en.Cars.Search) {
  fireEvent.change(screen.getByRole('combobox', { name: copy.pickupLocation }), { target: { value: 'LHR' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  fireEvent.click(screen.getByRole('option', { name: /LHR · London Heathrow/ }));
  const year = new Date().getUTCFullYear() + 1;
  fireEvent.change(screen.getByLabelText(copy.pickupDate), { target: { value: `${year}-01-15` } });
  fireEvent.change(screen.getByLabelText(copy.returnDate), { target: { value: `${year}-01-18` } });
  for (const field of screen.getAllByLabelText(copy.localTime)) fireEvent.change(field, { target: { value: '11:00' } });
  fireEvent.change(screen.getByLabelText(copy.driverAge), { target: { value: '35' } });
  fireEvent.change(screen.getByLabelText(copy.licenceYears), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText(copy.residence), { target: { value: 'GB' } });
}

describe('independent rental search form', () => {
  it('imports the selected quote only after review and blocks competing drafts while importing', async () => {
    const searches: unknown[] = [];
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      if (url === '/api/travel/import') return new Promise<Response>(resolve => { finish = resolve; });
      searches.push(JSON.parse(String(init.body)));
      return response({ id: 'imported-search', status: 'queued', creationKey: new Headers(init.headers).get('Idempotency-Key') });
    }));
    render(surface()); await completeForm();
    fireEvent.change(screen.getByLabelText(common.LinkImport.label), { target: { value: CAR_IMPORT_URL } });
    fireEvent.click(screen.getByRole('button', { name: common.LinkImport.import })); await settle();
    expect(screen.getByLabelText(en.Cars.Draft.description)).toBeDisabled();
    await act(async () => { finish(response({ kind: 'cars', url: CAR_IMPORT_URL, car: validateCarParseDraft({ sources: ['autoeurope'] }) })); });
    expect(searches).toEqual([]);
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(en.Cars.Draft.confirm));
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.search })); await settle();
    expect(searches).toEqual([expect.objectContaining({ sourceUrl: CAR_IMPORT_URL, sources: ['autoeurope'] })]);
  });
  it('applies suggestions only on request, preserves manual facts, and requires review before searching', async () => {
    const searches: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      if (url === '/api/cars/parse') return response({ draft: { filters: { transmission: 'automatic' }, warnings: ['Cross-border permission must be confirmed separately.'] } });
      searches.push(JSON.parse(String(init.body)));
      return response({ id: 'draft-search', status: 'queued', creationKey: new Headers(init.headers).get('Idempotency-Key') });
    }));
    render(surface()); await completeForm();
    fireEvent.change(screen.getByLabelText(en.Cars.Draft.description), { target: { value: 'Automatic car for a cross-border journey' } });
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.prepare })); await settle();
    expect(screen.getByLabelText(en.Cars.Search.transmission)).toHaveValue('any');
    expect(searches).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.apply }));
    expect(screen.getByLabelText(en.Cars.Search.transmission)).toHaveValue('automatic');
    expect(screen.getByLabelText(en.Cars.Search.driverAge)).toHaveValue(35);
    expect(screen.getByLabelText(en.Cars.Search.licenceYears)).toHaveValue(5);
    expect(screen.getByRole('combobox', { name: en.Cars.Search.pickupLocation })).toHaveValue(place.name);
    expect(screen.getByText(/Cross-border permission must/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(en.Cars.Search.driverAge).closest('form')!); await settle();
    expect(searches).toEqual([]);
    fireEvent.click(screen.getByLabelText(en.Cars.Draft.confirm));
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.search })); await settle();
    expect(searches).toEqual([expect.objectContaining({ driver: { age: 35, licenceYears: 5, residenceCountry: 'GB' }, filters: expect.objectContaining({ transmission: 'automatic' }) })]);
  });
  it('clears changed catalog selections and retains incomplete additional drivers for explicit completion', async () => {
    const searches: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      if (url === '/api/cars/parse') return response({ draft: { pickupQuery: 'London', currency: 'JPY', additionalDrivers: [{}], filters: { maxTotal: { currency: 'JPY', minor: 5000 } } } });
      searches.push(init); return response({});
    }));
    render(surface()); await completeForm();
    fireEvent.change(screen.getByLabelText(en.Cars.Draft.description), { target: { value: 'London, one additional driver, total budget JPY5000' } });
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.prepare })); await settle();
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.apply }));
    expect(screen.getByRole('combobox', { name: en.Cars.Search.pickupLocation })).toHaveValue('London');
    expect(screen.queryByText(/England · United Kingdom · Europe\/London/)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(en.Cars.Search.driverAge).map(input => (input as HTMLInputElement).value)).toEqual(['35', '']);
    expect(screen.getByLabelText('Maximum rental total (JPY)')).toHaveValue('5000');
    fireEvent.click(screen.getByLabelText(en.Cars.Draft.confirm));
    fireEvent.submit(screen.getAllByLabelText(en.Cars.Search.driverAge)[0]!.closest('form')!); await settle();
    expect(searches).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.Search.chooseLocation);
  });
  it.each(['cancel', 'timeout'] as const)('ignores late draft responses after %s and restores manual controls', async mode => {
    let finish!: (value: Response) => void, signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url !== '/api/cars/parse') return response([place]);
      signal = init.signal!;
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    render(surface());
    fireEvent.change(screen.getByLabelText(en.Cars.Search.driverAge), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(en.Cars.Draft.description), { target: { value: 'A rental car' } });
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.prepare })); await settle();
    expect(screen.getByLabelText(en.Cars.Search.driverAge)).toBeDisabled();
    if (mode === 'cancel') fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.cancel }));
    else await act(async () => { await vi.advanceTimersByTimeAsync(280_000); });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByLabelText(en.Cars.Search.driverAge)).toBeEnabled();
    await act(async () => { finish(response({ draft: { driver: { age: 23 } } })); });
    expect(screen.queryByRole('button', { name: en.Cars.Draft.apply })).not.toBeInTheDocument();
    expect(screen.getByLabelText(en.Cars.Search.driverAge)).toHaveValue(42);
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.Draft[mode === 'cancel' ? 'cancelled' : 'timedOut']);
  });
  it('keeps manual values after invalid draft data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ draft: { driver: { age: 10 } } })));
    render(surface());
    fireEvent.change(screen.getByLabelText(en.Cars.Search.driverAge), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(en.Cars.Draft.description), { target: { value: 'A rental car' } });
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.prepare })); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(en.Cars.Draft.failed);
    expect(screen.getByLabelText(en.Cars.Search.driverAge)).toHaveValue(42);
    expect(screen.queryByRole('button', { name: en.Cars.Draft.apply })).not.toBeInTheDocument();
  });
  it('discards pending AI and manual details when the account changes', async () => {
    let finish!: (value: Response) => void, signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal!; return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const mounted = render(surface());
    fireEvent.change(screen.getByLabelText(en.Cars.Search.driverAge), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(en.Cars.Draft.description), { target: { value: 'Private rental description' } });
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Draft.prepare })); await settle();
    mounted.rerender(<NextIntlClientProvider locale="en" messages={en}><CarSearchForm actorScope="bob" defaultCurrency="EUR" defaultSources={['autoeurope']} options={carFormOptions('en')} /></NextIntlClientProvider>);
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish(response({ draft: { pickupQuery: 'Private location' } })); });
    expect(screen.getByLabelText(en.Cars.Search.driverAge)).toHaveValue(null);
    expect(screen.getByLabelText(en.Cars.Draft.description)).toHaveValue('');
    expect(screen.getByLabelText(en.Cars.Search.currency)).toHaveValue('EUR');
    expect(screen.queryByRole('button', { name: en.Cars.Draft.apply })).not.toBeInTheDocument();
  });
  it('accepts a local comma decimal without changing the currency or rounding minor units', async () => {
    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      submitted = JSON.parse(String(init.body));
      return response({ id: 'localized-search', status: 'queued', creationKey: new Headers(init.headers).get('Idempotency-Key') });
    }));
    render(surface('de', de)); await completeForm(de.Cars.Search);
    fireEvent.change(screen.getByLabelText('Maximaler Mietgesamtpreis (GBP)'), { target: { value: '150,50' } });
    fireEvent.click(screen.getByRole('button', { name: de.Cars.Search.search })); await settle();
    expect(submitted).toMatchObject({ currency: 'GBP', filters: { maxTotal: { currency: 'GBP', minor: 15050 } } });
  });
  it('recovers a transient pre-send storage failure with its original identity and no duplicate request', async () => {
    const writes: string[] = [], posts: RequestInit[] = [];
    const prototype = Object.getPrototypeOf(sessionStorage) as Storage, original = prototype.setItem; let blocked = true;
    vi.spyOn(prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      writes.push(value); if (blocked) throw new DOMException('Storage denied'); original.call(this, key, value);
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      posts.push(init); return response({ id: 'recovered-search', status: 'queued', creationKey: new Headers(init.headers).get('Idempotency-Key') });
    }));
    render(surface()); await completeForm();
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.search })); await settle();
    expect(posts).toEqual([]); blocked = false;
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.retryStorage }));
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.recoverSearch })); await settle();
    expect(screen.getByRole('link', { name: en.Cars.Search.openSearch })).toHaveAttribute('href', '/cars/search/recovered-search');
    expect(new Set(writes).size).toBe(1);
    expect(new Headers(posts[0]!.headers).get('Idempotency-Key')).toBe(JSON.parse(writes[0]!).key);
  });
  it('never silently discards corrupt recovery data and requires confirmed successful removal', async () => {
    const storageKey = 'ff-car-search:alice'; sessionStorage.setItem(storageKey, '{broken');
    render(surface());
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeDisabled();
    expect(screen.getByLabelText(en.Cars.Draft.description)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.retryStorage }));
    expect(sessionStorage.getItem(storageKey)).toBe('{broken');
    fireEvent.click(screen.getByText(en.Cars.Search.discardLabel));
    expect(screen.getByRole('button', { name: en.Cars.Search.confirmDiscard })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(en.Cars.Search.discardConfirm));
    const remove = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'removeItem').mockImplementation(() => { throw new DOMException('Storage denied'); });
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.confirmDiscard }));
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeDisabled();
    expect(sessionStorage.getItem(storageKey)).toBe('{broken'); remove.mockRestore();
    fireEvent.click(screen.getByLabelText(en.Cars.Search.discardConfirm));
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.confirmDiscard }));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeEnabled();
  });
  it.each([{ locale: 'en', messages: en }, { locale: 'es', messages: es }, { locale: 'pt', messages: pt }, { locale: 'fr', messages: fr }, { locale: 'de', messages: de }])('offers a translated search without inventing driver details in $locale', ({ locale, messages }) => {
    render(surface(locale, messages));
    expect(screen.getByRole('heading', { name: messages.Cars.Search.findCar })).toBeInTheDocument();
    expect(screen.getByLabelText(messages.Cars.Search.driverAge)).toHaveValue(null);
    expect(screen.getByLabelText(messages.Cars.Search.residence)).toHaveValue('');
    const residence = screen.getByLabelText<HTMLSelectElement>(messages.Cars.Search.residence);
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    for (const code of ['GB', 'DE', 'FR']) {
      const matches = [...residence.options].filter(option => option.text === names.of(code));
      expect(matches.map(option => option.value)).toEqual([code]);
    }
    fireEvent.change(residence, { target: { value: 'GB' } });
    expect(residence).toHaveValue('GB');
    expect(screen.getByLabelText(messages.Cars.Search.currency)).toHaveValue('GBP');
  });
  it('sends catalog identities and explicit local rental details, then opens the acknowledged search', async () => {
    const posts: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      posts.push(init);
      return response({ id: 'search-created', status: 'queued', creationKey: new Headers(init.headers).get('Idempotency-Key') });
    }));
    render(surface()); await completeForm();
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.search })); await settle();
    expect(screen.getByRole('link', { name: en.Cars.Search.openSearch })).toHaveAttribute('href', '/cars/search/search-created');
    const body = JSON.parse(String(posts[0]!.body));
    expect(body).toMatchObject({ pickup: { id: place.id, version: place.version }, dropoff: { id: place.id, version: place.version }, driver: { age: 35, licenceYears: 5, residenceCountry: 'GB' }, currency: 'GBP', sources: ['discovercars', 'autoeurope'] });
    expect(Object.keys(body.pickup).sort()).toEqual(['id', 'version']);
    expect(Object.keys(body.pickupAt).sort()).toEqual(['date', 'time']);
  });
  it('recovers a lost acknowledgement across a remount with the same body and idempotency key', async () => {
    const posts: RequestInit[] = []; let offline = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      posts.push(init);
      if (offline) throw new TypeError('Lost response');
      return response({ id: 'original-search', status: 'running', creationKey: new Headers(init.headers).get('Idempotency-Key') });
    }));
    const mounted = render(surface()); await completeForm();
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.search })); await settle();
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeDisabled();
    mounted.unmount(); offline = false; render(surface());
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.recoverSearch })); await settle();
    expect(screen.getByRole('link', { name: en.Cars.Search.openSearch })).toHaveAttribute('href', '/cars/search/original-search');
    expect(posts[1]!.body).toBe(posts[0]!.body);
    expect(new Headers(posts[1]!.headers).get('Idempotency-Key')).toBe(new Headers(posts[0]!.headers).get('Idempotency-Key'));
  });
  it('keeps an unreadable rejection locked and refuses an acknowledgement for another request', async () => {
    let retry = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/cars/locations?')) return response([place]);
      return retry ? response({ id: 'wrong-search', status: 'queued', creationKey: crypto.randomUUID() }) : new Response('<html>Bad gateway</html>', { status: 400 });
    }));
    render(surface()); await completeForm();
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.search })); await settle(); retry = true;
    fireEvent.click(screen.getByRole('button', { name: en.Cars.Search.recoverSearch })); await settle();
    expect(screen.getByRole('button', { name: en.Cars.Search.search })).toBeDisabled();
    expect(screen.queryByRole('link', { name: en.Cars.Search.openSearch })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(en.Cars.Search.searchUncertain);
  });
  it('clears a selected location when its text is edited and allows keyboard selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([place])));
    render(surface());
    const input = screen.getByRole('combobox', { name: en.Cars.Search.pickupLocation });
    fireEvent.change(input, { target: { value: 'LHR' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue(place.name);
    expect(screen.getByText(/England · United Kingdom · Europe\/London/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'L' } });
    expect(screen.queryByText(/England · United Kingdom · Europe\/London/)).not.toBeInTheDocument();
  });
});
