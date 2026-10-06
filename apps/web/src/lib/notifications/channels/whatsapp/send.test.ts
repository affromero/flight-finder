import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToChannel, prepareStoredConfig } from '../index';
import { decryptChannelConfig, mergeStoredConfig, redactChannelConfig } from '../config';
import { formatNewLowMessage } from '../../format';
import type { ChannelMessage } from '../types';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
const config = { gatewayUrl: 'http://127.0.0.1/gateway/', apiKey: 'fixture-api-key', account: 'fixture-account', destination: '+573001234567' };
const generic: ChannelMessage = { title: 'Flight Finder test', body: 'UTF-8: Bogotá ✈ €100', url: 'http://private.example/q/one', data: { test: true } };
const channel = (changes: Record<string, unknown> = {}, userId: string | null = null) => ({ id: 'whatsapp', type: 'whatsapp' as const, userId, config: prepareStoredConfig('whatsapp', { ...config, ...changes }) });
const flight = () => formatNewLowMessage({ route: { origin: 'BOG', destination: 'MAD' }, baseUrl: 'http://private.example', alert: {
  queryId: 'one', currentMin: 100, baseline: 150, drop: 50, currency: 'EUR', airline: 'Fixture Air', travelDate: new Date('2027-06-15'), bookingUrl: 'https://booking.example/one', flightNumber: null,
} });
beforeEach(() => { dns.lookup.mockReset(); dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('WhatsApp gateway channels', () => {
  it('sends one phone destination using the documented gateway prefix, header and JSON contract', async () => {
    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      expect(url).toBe('http://127.0.0.1/gateway/api/messages/send');
      expect(request.redirect).toBe('error');
      expect(new Headers(request.headers).get('X-API-Key')).toBe(config.apiKey);
      sent = JSON.parse(String(request.body));
      return new Response(null, { status: 204 });
    });
    await sendToChannel(channel(), generic);
    expect(sent).toEqual({ account: config.account, phone: config.destination, message: `${generic.title}\n\n${generic.body}` });
  });

  it('uses the group endpoint and includes the tracker link only when explicitly requested', async () => {
    const sent: { url: string; data: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      sent.push({ url, data: JSON.parse(String(request.body)) });
      return new Response(null, { status: 202 });
    });
    await sendToChannel(channel({ destinationType: 'group', destination: 'fixture@g.us', includeTrackerLink: true }), generic);
    expect(sent).toEqual([{ url: 'http://127.0.0.1/gateway/api/groups/send-message', data: {
      account: config.account, groupId: 'fixture@g.us', message: `${generic.title}\n\n${generic.body}\n\n${generic.url}`,
    } }]);
  });

  it('encrypts and redacts the API key, account and destination while keeping them through ordinary edits', () => {
    const stored = prepareStoredConfig('whatsapp', config);
    for (const field of ['apiKey', 'account', 'destination'] as const) expect(stored[field]).not.toBe(config[field]);
    expect(redactChannelConfig('whatsapp', stored)).toEqual({ gatewayUrl: 'http://127.0.0.1/gateway', destinationType: 'phone', locale: 'en',
      includeTrackerLink: false, apiKeySet: true, accountSet: true, destinationSet: true });
    const updated = mergeStoredConfig('whatsapp', stored, { apiKey: '', account: '', destination: '', locale: 'es' });
    expect(decryptChannelConfig('whatsapp', updated)).toMatchObject({ ...config, gatewayUrl: 'http://127.0.0.1/gateway', locale: 'es' });
    for (const field of ['apiKey', 'account', 'destination']) expect(() => mergeStoredConfig('whatsapp', stored, { [field]: null })).toThrow();
  });

  it('requires a fresh destination when changing between phone and group delivery', () => {
    const stored = prepareStoredConfig('whatsapp', config);
    for (const destination of [undefined, '', '  ', null]) expect(() => mergeStoredConfig('whatsapp', stored, { destinationType: 'group', destination })).toThrow(/new destination/);
    expect(decryptChannelConfig('whatsapp', mergeStoredConfig('whatsapp', stored, { destinationType: 'group', destination: 'new@g.us' }))).toMatchObject({ destinationType: 'group', destination: 'new@g.us' });
  });

  it.each([
    { gatewayUrl: 'ftp://example.com' }, { gatewayUrl: 'https://user:password@example.com' }, { gatewayUrl: 'https://example.com?' },
    { gatewayUrl: 'https://example.com#' }, { gatewayUrl: 'https://example.com?key=hidden' }, { gatewayUrl: 'bad' },
    { destination: '573001234567' }, { destination: '+0001234567' }, { destination: '+1234567890123456' },
    { destinationType: 'other' }, { destinationType: 'group', destination: 'two destinations' }, { destination: '' },
    { account: '' }, { apiKey: 'secret\r\nX-New: value' }, { apiKey: 'clé' }, { locale: 'unknown' }, { includeTrackerLink: 'true' },
  ])('rejects malformed gateway settings %j before transport', changes => {
    expect(() => prepareStoredConfig('whatsapp', { ...config, ...changes })).toThrow();
  });

  it.each([['en', 'New low'], ['es', 'Nuevo mínimo'], ['pt', 'Novo mínimo'], ['de', 'Neuer Tiefstpreis'], ['fr', 'Nouveau minimum']])('renders flight price content in %s without sharing a private tracker URL', async (locale, phrase) => {
    let sent = '';
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      sent = JSON.parse(String(request.body)).message;
      return new Response(null, { status: 200 });
    });
    const message = flight();
    await sendToChannel(channel({ locale }), message);
    expect(sent).toContain(phrase);
    expect(sent).toContain('EUR');
    expect(sent).toContain('Fixture Air');
    expect(sent).toContain('2027-06-15');
    expect(sent).toContain('https://booking.example/one');
    expect(sent).not.toContain('private.example');
  });

  it('keeps booking links alongside explicitly shared tracker links and avoids duplicate destinations', async () => {
    let sent = '';
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => { sent = JSON.parse(String(request.body)).message; return new Response(null, { status: 200 }); });
    const message = flight();
    await sendToChannel(channel({ includeTrackerLink: true }), message);
    expect(sent).toContain(message.url);
    expect(sent).toContain('https://booking.example/one');
    await sendToChannel(channel({ includeTrackerLink: true }), { ...message, url: 'https://booking.example/one' });
    expect(sent.split('\n').filter(line => line === 'https://booking.example/one')).toHaveLength(1);
  });

  it('preserves generic hotel, car and test message content in a channel with a flight language selected', async () => {
    let sent = '';
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => { sent = JSON.parse(String(request.body)).message; return new Response(null, { status: 200 }); });
    await sendToChannel(channel({ locale: 'es' }), generic);
    expect(sent).toBe(`${generic.title}\n\n${generic.body}`);
  });

  it.each([400, 429, 503])('reports HTTP %i without leaking gateway secrets or response bodies', async status => {
    vi.stubGlobal('fetch', async () => new Response(`${config.apiKey} ${config.destination}`, { status }));
    await expect(sendToChannel(channel(), generic)).rejects.toThrow(`WhatsApp gateway HTTP ${status}`);
  });

  it('blocks a user-owned channel aimed at an internal gateway', async () => {
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    await expect(sendToChannel(channel({}, 'owner'), generic)).rejects.toThrow(/host is not allowed/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a public hostname whose DNS includes a private address', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    await expect(sendToChannel(channel({ gatewayUrl: 'https://gateway.example' }, 'owner'), generic)).rejects.toThrow(/host is not allowed/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('pins a user-owned public gateway and rejects redirect forwarding of its credentials', async () => {
    let redirected: RequestRedirect | undefined, pinned = false;
    vi.stubGlobal('fetch', async (url: string, request: RequestInit & { dispatcher?: unknown }) => {
      redirected = request.redirect; pinned = Boolean(request.dispatcher);
      return new Response(null, { status: 307, headers: { Location: 'http://127.0.0.1/private' } });
    });
    await expect(sendToChannel(channel({ gatewayUrl: 'https://gateway.example' }, 'owner'), generic)).rejects.toThrow(/HTTP 307/);
    expect(redirected).toBe('error'); expect(pinned).toBe(true);
  });

  it('cancels a pending DNS lookup without starting a request', async () => {
    let ready!: () => void;
    const lookingUp = new Promise<void>(resolve => { ready = resolve; });
    dns.lookup.mockImplementation(async () => { ready(); return new Promise(() => undefined); });
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    const abort = new AbortController();
    const sending = expect(sendToChannel(channel({ gatewayUrl: 'https://gateway.example' }, 'owner'), generic, { signal: abort.signal })).rejects.toThrow('Owner cancelled');
    await lookingUp; abort.abort(new Error('Owner cancelled')); await sending;
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds a gateway request that never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => new Promise<Response>((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
    }));
    const sending = expect(sendToChannel(channel(), generic)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(15_000); await sending;
  });
});
