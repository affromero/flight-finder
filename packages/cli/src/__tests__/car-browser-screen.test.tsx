import React from 'react';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { stripVTControlCharacters } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import { expect, it, vi } from 'vitest';
import { CarBrowser as Browser } from '../lib/car-browser.js';
import { CarClient } from '../lib/car-client.js';
import { CarBrowser } from '../screens/CarBrowser.js';
import { CarConfirmation } from '../screens/CarConfirmation.js';
import { carTrackerViewFixture } from '../../../../apps/web/src/test/car-fixtures.js';

it('keeps protection receipt confirmation visible in a narrow terminal while every saved field remains scrollable', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 20, isTTY: true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  const frames: string[] = []; let confirmed = false;
  stdout.on('data', chunk => { const frame = stripVTControlCharacters(String(chunk)); if (frame.includes('Type yes, then Enter:')) frames.push(frame); });
  const choiceId = 'c51f31ce-1f53-486b-b84c-2817429f3a73';
  const instance = render(<CarConfirmation rows={20} confirmation={{ operation: { kind: 'protect', id: 'parent-search', revision: null,
    body: { offerId: 'selected-rental', choiceId } }, scope: 'user:alice', origin: 'https://rental.example.test', label: 'Saved protection choice',
    receiptPath: `/private/${'long-private-directory/'.repeat(10)}receipt.json`, receipt: null, conflict: false,
    locations: ['Pickup search location (DiscoverCars): Terminal collection area with a long provider label', 'Return search location (DiscoverCars): Separate return entrance'],
  }} onConfirm={() => { confirmed = true; }} />, { stdout, stdin, stderr, debug: true, interactive: true, patchConsole: false });
  try {
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    frames.length = 0; stdout.columns = 32; stdout.emit('resize');
    await vi.waitFor(() => {
      const frame = frames.at(-1);
      expect(frame).toContain('Esc cancels');
      expect(frame!.trimEnd().split('\n').length).toBeLessThanOrEqual(20);
      expect(frame!.split('\n').every(line => line.length <= 32)).toBe(true);
    });
    frames.splice(0, frames.length - 1);
    for (let index = 0; index < 60; index++) { stdin.push('\u001b[B'); await instance.waitUntilRenderFlush(); }
    const text = frames.join('\n');
    expect(text.replace(/\s+/g, ' ')).toContain('Does not book a car or buy coverage.');
    expect(text.replace(/\s+/g, '')).toContain(choiceId);
    expect(text.replace(/\s+/g, ' ')).toContain('Terminal collection area with a long provider label');
    expect(text.replace(/\s+/g, ' ')).toContain('Separate return entrance');
    expect(confirmed).toBe(false);
    for (const frame of frames) {
      expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(20);
      expect(frame.split('\n').every(line => line.length <= 32)).toBe(true);
      expect(frame).toContain('Esc cancels');
    }
    stdin.push('yes'); await vi.waitFor(() => expect(frames.at(-1)).toContain('Enter: yes'));
    stdin.push('\r'); await vi.waitFor(() => expect(confirmed).toBe(true));
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

it.each([
  { editing: false, behavior: 'renders exact prices, opens history, resizes, and exits without server mutations' },
  { editing: true, behavior: 'requires confirmation, recovers a lost refresh reply, and cancels an unsubmitted pause by keyboard' },
])('$behavior', async ({ editing }) => {
  const methods: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'car-browser-screen-'));
  const jobs = new Set<string>(); let loseRefreshReply = true;
  let scope = 'user:alice', delayDetail = false;
  let releaseDetail: (() => void) | undefined;
  let tracker = { ...carTrackerViewFixture(), label: 'Heathrow rental', latestPriceMinor: 12345 };
  tracker.search.pickup.providerNames = { discovercars: 'Long terminal collection area for the selected rental' };
  tracker.search.dropoff.providerNames = { discovercars: 'Separate vehicle return entrance' };
  const deliveries = Array.from({ length: 8 }, (_, index) => ({ id: `delivery-${index}`, trackerId: tracker.id, status: index === 7 ? 'accepted' : 'retrying', createdAt: tracker.createdAt, acknowledgedChannels: index === 7 ? 2 : 1, nextAttemptAt: index === 7 ? null : tracker.createdAt }));
  const server = createServer(async (request, response) => {
    methods.push(request.method!);
    if (request.method === 'POST') {
      const refreshKey = String(request.headers['idempotency-key']); jobs.add(refreshKey);
      if (loseRefreshReply) { loseRefreshReply = false; response.destroy(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: { id: 'run-one', status: 'success', trackerId: tracker.id, refreshKey } })); return;
    }
    if (request.method === 'PATCH') {
      let body = ''; for await (const chunk of request) body += String(chunk);
      tracker = { ...tracker, active: Boolean(JSON.parse(body).active), revision: tracker.revision + 1 };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: { tracker } })); return;
    }
    if (delayDetail && request.url === `/api/cars/${tracker.id}`) await new Promise<void>(resolve => { releaseDetail = resolve; });
    const data = request.url === '/api/cars/session' ? { scope, isAdmin: false }
      : request.url === `/api/cars/${tracker.id}` ? { tracker, snapshots: [], runs: [], latestObservation: null, deliveries, notificationsConfigured: false, canReassign: false }
        : { trackers: [tracker], nextCursor: null };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server');
  const stdout = Object.assign(new PassThrough(), { columns: 90, rows: 24, isTTY: true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  let output = '';
  let diagnostics = '';
  stdout.on('data', chunk => { output += String(chunk); });
  stderr.on('data', chunk => { diagnostics += String(chunk); });
  const browser = new Browser(new CarClient(`http://127.0.0.1:${address.port}`), false, directory);
  const instance = render(<CarBrowser browser={browser} signal={new AbortController().signal} />, {
    stdout, stdin, stderr, interactive: true, exitOnCtrlC: false, patchConsole: false,
  });
  try {
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Heathrow rental'));
    expect(stripVTControlCharacters(output)).toContain('123.45');
    output = ''; stdin.push('\r');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('PRICE EVIDENCE'));
    expect(stripVTControlCharacters(output)).toContain('No observations yet');
    expect(stripVTControlCharacters(output)).toContain('No notification channel configured');
    output = ''; stdin.push('l');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('RENTAL LOCATIONS'));
    output = ''; stdout.columns = 32; stdout.emit('resize');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('RENTAL LOCATIONS'));
    expect(stripVTControlCharacters(output)).not.toContain('Long terminal collection area for the selected');
    for (let index = 0; index < 25; index++) { stdin.push('\u001b[B'); await instance.waitUntilRenderFlush(); }
    expect(stripVTControlCharacters(output).replace(/\s+/g, ' ')).toContain('Review the rental conditions');
    output = ''; stdout.columns = 90; stdout.emit('resize');
    for (let index = 0; index < 25; index++) { stdin.push('\u001b[A'); await instance.waitUntilRenderFlush(); }
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Long terminal collection area'));
    expect(stripVTControlCharacters(output)).toContain('Long terminal collection area');
    expect(stripVTControlCharacters(output)).toContain('Separate vehicle return entrance');
    for (const key of ['p', 'c', 'x']) { stdin.push(key); await instance.waitUntilRenderFlush(); }
    expect(browser.getSnapshot().confirmation).toBeNull();
    expect(methods.every(method => method === 'GET')).toBe(true);
    output = ''; stdin.push('\u001b');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('PRICE EVIDENCE'));
    output = ''; stdin.push('d');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('NOTIFICATION DELIVERY'));
    expect(stripVTControlCharacters(output)).toContain('Waiting to retry');
    expect(stripVTControlCharacters(output)).toContain('1 channel acknowledgements');
    for (let index = 0; index < 8; index++) { stdin.push('\u001b[B'); await instance.waitUntilRenderFlush(); }
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Accepted by channels'));
    expect(methods.every(method => method === 'GET')).toBe(true);
    output = ''; stdin.push('d');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('PRICE EVIDENCE'));
    if (editing) {
      output = ''; stdin.push('c');
      await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('CONFIRM CHANGE / Check prices'));
      expect(methods.every(method => method === 'GET')).toBe(true);
      stdin.push('yes'); await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Enter: yes'));
      stdin.push('\r');
      await vi.waitFor(() => expect(browser.getSnapshot().recoveries[0]?.outcome).toBe('unconfirmed'));
      expect(diagnostics).toContain(browser.getReceiptPaths()[0]);
      output = ''; stdin.push('t');
      await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('RECOVER A SAVED REQUEST'));
      stdin.push('1'); await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Receipt: 1')); stdin.push('\r');
      await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('RETRY SAVED REQUEST'));
      output = ''; stdin.push('yes'); await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Enter: yes')); stdin.push('\r');
      await vi.waitFor(() => expect(browser.getSnapshot().recoveries[0]?.outcome).toBe('confirmed'));
      await vi.waitFor(() => expect(browser.getSnapshot().busy).toBe(false));
      expect(jobs.size).toBe(1);
      output = ''; stdin.push('p');
      await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Pause tracking'));
      stdin.push('\u001b');
      await vi.waitFor(() => expect(browser.getSnapshot().confirmation).toBeNull());
      expect(methods).not.toContain('PATCH');
      stdin.push('p'); await vi.waitFor(() => expect(browser.getSnapshot().confirmation).not.toBeNull());
      output = ''; stdin.push('yes'); await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Enter: yes')); stdin.push('\r');
      await vi.waitFor(() => expect(browser.getSnapshot().detail?.tracker.active).toBe(false));
    }
    stdout.rows = 16; stdout.columns = 42; stdout.emit('resize');
    await instance.waitUntilRenderFlush();
    output = ''; stdin.push('l');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('RENTAL LOCATIONS'));
    for (let index = 0; index < 25; index++) { stdin.push('\u001b[B'); await instance.waitUntilRenderFlush(); }
    expect(stripVTControlCharacters(output).replace(/\s+/g, ' ')).toContain('Review the rental conditions');
    output = ''; stdin.push('\u001b');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('PRICE EVIDENCE'));
    output = ''; stdin.push('d');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('NOTIFICATION DELIVERY'));
    expect(stripVTControlCharacters(output)).toContain('1 of 8');
    for (let index = 0; index < 8; index++) { stdin.push('\u001b[B'); await instance.waitUntilRenderFlush(); }
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('8 of 8'));
    output = ''; stdin.push('\u001b');
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('YOUR TRACKERS'));
    stdin.push('\r'); await vi.waitFor(() => expect(browser.getSnapshot().detail).not.toBeNull());
    stdin.push('l'); await instance.waitUntilRenderFlush();
    delayDetail = true;
    const reloading = browser.reload();
    await vi.waitFor(() => expect(releaseDetail).toBeDefined());
    scope = 'user:bob'; output = ''; releaseDetail!();
    await reloading; await instance.waitUntilRenderFlush();
    expect(browser.getSnapshot()).toMatchObject({ hidden: true, detail: null, trackers: [] });
    expect(stripVTControlCharacters(output)).not.toContain('RENTAL LOCATIONS');
    expect(stripVTControlCharacters(output)).not.toContain('Separate vehicle return entrance');
    stdin.push('q'); await instance.waitUntilExit();
    expect(browser.getSnapshot()).toMatchObject({ hidden: true, trackers: [], detail: null });
    expect(methods.filter(method => method !== 'GET')).toEqual(editing ? ['POST', 'POST', 'PATCH'] : []);
  } finally {
    instance.unmount(); instance.cleanup(); browser.close(); await browser.settle();
    stdin.destroy(); stdout.destroy(); stderr.destroy();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
