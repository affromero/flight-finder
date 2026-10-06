import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToChannel, prepareStoredConfig } from '../index';
import { decryptChannelConfig, mergeStoredConfig, redactChannelConfig } from '../config';
import type { ChannelMessage } from '../types';

const config = { token: 'a'.repeat(30), userKey: 'b'.repeat(30) };
const message: ChannelMessage = { title: 'Fare to Bogotá', body: '€123 for two adults', url: 'https://example.test/q/one', data: { eventId: 'flight:one' } };
const channel = () => ({ id: 'pushover-one', type: 'pushover' as const, userId: null, config: prepareStoredConfig('pushover', config) });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Pushover channel delivery', () => {
  it('delivers UTF-8 content and credentials through the encrypted channel dispatcher', async () => {
    let sent: URLSearchParams | undefined;
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      expect(url).toBe('https://api.pushover.net/1/messages.json');
      expect(request.redirect).toBe('error');
      sent = new URLSearchParams(String(request.body));
      return Response.json({ status: 1, request: 'accepted-request' });
    });
    await sendToChannel(channel(), message);
    expect(sent?.get('token')).toBe(config.token);
    expect(sent?.get('user')).toBe(config.userKey);
    expect(sent?.get('title')).toBe(message.title);
    expect(sent?.get('message')).toBe(message.body);
    expect(sent?.get('url')).toBe(message.url);
    expect(sent?.get('priority')).toBe('0');
  });

  it('encrypts and redacts both keys while preserving them through non-secret edits', () => {
    const stored = prepareStoredConfig('pushover', config);
    expect(stored.token).not.toBe(config.token);
    expect(stored.userKey).not.toBe(config.userKey);
    expect(redactChannelConfig('pushover', stored)).toEqual({ priority: 0, tokenSet: true, userKeySet: true });
    const updated = mergeStoredConfig('pushover', stored, { token: '', userKey: '', device: 'phone,tablet' });
    expect(decryptChannelConfig('pushover', updated)).toEqual({ ...config, priority: 0, device: 'phone,tablet' });
    expect(() => mergeStoredConfig('pushover', stored, { userKey: null })).toThrow(/userKey/);
  });

  it.each([
    { priority: 3 }, { priority: 0.5 }, { token: 'bad' }, { userKey: 'bad' },
    { priority: 2 }, { priority: 2, retry: 29, expire: 60 },
    { priority: 2, retry: 30, expire: 10801 }, { device: 'phone&token=secret' },
    { device: 'x'.repeat(26) }, { device: `phone,${'x'.repeat(26)}` },
  ])('rejects invalid credentials or delivery settings %j', changes => {
    expect(() => prepareStoredConfig('pushover', { ...config, ...changes })).toThrow();
  });

  it('sends emergency parameters and omits an absent tracker URL', async () => {
    let sent: URLSearchParams | undefined;
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      sent = new URLSearchParams(String(request.body));
      return Response.json({ status: 1, receipt: 'emergency-receipt' });
    });
    await sendToChannel({ ...channel(), config: prepareStoredConfig('pushover', { ...config, priority: 2, retry: 30, expire: 10800, device: 'phone' }) }, { ...message, url: '' });
    expect(sent?.get('retry')).toBe('30');
    expect(sent?.get('expire')).toBe('10800');
    expect(sent?.get('device')).toBe('phone');
    expect(sent?.has('url')).toBe(false);
  });

  it('clears device targeting and emergency priority while keeping encrypted keys', () => {
    const stored = prepareStoredConfig('pushover', { ...config, priority: 2, device: 'phone', retry: 30, expire: 60 });
    const changed = mergeStoredConfig('pushover', stored, { priority: 0, device: '' });
    expect(decryptChannelConfig('pushover', changed)).toEqual({ ...config, priority: 0 });
  });

  it('bounds Unicode messages and omits oversized links without changing their destination', async () => {
    let sent: URLSearchParams | undefined;
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      sent = new URLSearchParams(String(request.body));
      return Response.json({ status: 1 });
    });
    await sendToChannel(channel(), { ...message, title: '✈️😀'.repeat(251), body: '😀'.repeat(1025), url: `https://booking.example/?${'x'.repeat(512)}` });
    expect(Array.from(sent?.get('title') ?? '')).toHaveLength(250);
    expect(Array.from(sent?.get('message') ?? '')).toHaveLength(1024);
    expect(sent?.get('message')).toBe(`${'😀'.repeat(1023)}…`);
    expect(sent?.has('url')).toBe(false);
  });

  it('keeps a link at the provider length boundary intact', async () => {
    let sent: URLSearchParams | undefined;
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
      sent = new URLSearchParams(String(request.body));
      return Response.json({ status: 1 });
    });
    const url = `https://booking.example/${'x'.repeat(488)}`;
    await sendToChannel(channel(), { ...message, url });
    expect(sent?.get('url')).toBe(url);
  });

  it.each([400, 429, 503])('reports HTTP %i without echoing provider credentials', async status => {
    vi.stubGlobal('fetch', async () => new Response(config.token + config.userKey, { status }));
    await expect(sendToChannel(channel(), message)).rejects.toThrow(`Pushover HTTP ${status}`);
  });

  it.each([{ status: 0, errors: [config.token] }, { status: '1' }, null])('rejects an unaccepted acknowledgment without echoing its body', async result => {
    vi.stubGlobal('fetch', async () => Response.json(result));
    await expect(sendToChannel(channel(), message)).rejects.toThrow('Pushover did not accept the notification');
  });

  it.each(['not-json', 'x'.repeat(16385)])('rejects malformed or oversized acknowledgment bodies', async body => {
    vi.stubGlobal('fetch', async () => new Response(body));
    await expect(sendToChannel(channel(), message)).rejects.toThrow(/acknowledgment/);
  });

  it('cancels a hanging acknowledgment body and releases the stream', async () => {
    const abort = new AbortController();
    let cancelled = false, arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start() { arrived(); }, cancel() { cancelled = true; } })));
    const sending = expect(sendToChannel(channel(), message, { signal: abort.signal })).rejects.toThrow('Cancelled by owner');
    await ready;
    abort.abort(new Error('Cancelled by owner'));
    await sending;
    expect(cancelled).toBe(true);
  });

  it('expires a provider request that never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => new Promise<Response>((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
    }));
    const sending = expect(sendToChannel(channel(), message)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(15000);
    await sending;
  });
});
