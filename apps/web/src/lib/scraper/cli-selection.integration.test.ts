import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import type { ExtractionConfig, TravelJob } from '@/generated/prisma/client';
import type { createAccessFixture } from '@/test/access-fixture';
import type { createStateBoundary } from '@/test/state-fixture';
const persistence = vi.hoisted(() => ({ state: null as ReturnType<typeof createStateBoundary> | null }));
vi.mock('@/lib/sidedoor/store', async () => {
  const { createStateBoundary } = await import('@/test/state-fixture');
  persistence.state = createStateBoundary();
  return { sharedStateStore: <State>(id: string, parse: (value: unknown) => State, initial: () => State) => id === 'access' ? boundary.fixture!.access.store : persistence.state!.store(id, parse, initial) };
});

const boundary = vi.hoisted(() => ({ fixture: null as ReturnType<typeof createAccessFixture> | null, config: {} as Record<string, unknown>, user: null as Record<string, unknown> | null, token: '', spawn: vi.fn(), upsert: vi.fn(), output: '{}' }));
vi.mock('@/lib/sidedoor/service', async () => {
  const { createAccessFixture } = await import('@/test/access-fixture');
  const fixture = createAccessFixture();
  boundary.fixture = fixture;
  const { FlightFinderAccessStore } = await import('@/lib/sidedoor/access-store');
  return { sharedAccess: fixture.access, sharedProfiles: fixture.profiles, sharedAccessStore: new FlightFinderAccessStore(), SHARED_SESSION_COOKIE: 'ft-session' };
});
vi.mock('@/lib/prisma', () => {
  const database = {
    sidedoorState: { findUnique: async () => ({ state: await boundary.fixture!.access.store.read() }) },
    extractionConfig: { findFirst: async () => boundary.config, findUnique: async () => boundary.config, findUniqueOrThrow: async () => boundary.config, upsert: boundary.upsert },
    user: { findUnique: async () => boundary.user, findMany: async () => boundary.user ? [{ ...boundary.user, username: boundary.user.id, createdAt: new Date() }] : [] }, apiUsageLog: { create: async () => ({}) },
  };
  return { prisma: { ...database, $transaction: async (operation: (value: typeof database) => Promise<unknown>) => operation(database) } };
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => boundary.token ? { value: boundary.token } : undefined }) }));
vi.mock('node:child_process', () => ({ spawn: boundary.spawn, execSync: vi.fn() }));
vi.mock('./navigate', async importOriginal => ({
  ...await importOriginal<typeof import('./navigate')>(),
  navigateGoogleFlights: async () => ({ html: 'Delta $623', url: 'https://www.google.com/travel/flights', source: 'google_flights', resultsFound: true }),
}));

let executableDirectory = '';
function executionArgs(): string[] {
  return JSON.parse(readFileSync(join(executableDirectory, 'args.json'), 'utf8')) as string[];
}
function answer(value: string) {
  boundary.output = value;
  writeFileSync(join(executableDirectory, 'answer.txt'), value);
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  executableDirectory = mkdtempSync(join(tmpdir(), 'flight-cli-selection-'));
  writeFileSync(join(executableDirectory, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(args));
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(args[args.indexOf('-o') + 1], fs.readFileSync(path.join(__dirname, 'answer.txt')));
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}})+'\\n');
});
`, { mode: 0o755 });
  vi.stubEnv('PATH', executableDirectory);
  answer('{}');
  vi.stubEnv('REDIS_URL', ''); vi.stubEnv('SELF_HOSTED', 'true');
  boundary.config = { id: 'singleton', provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'default', multiUserMode: false, setupComplete: true };
  boundary.config.updatedAt = new Date(0);
  boundary.config.providerRevision = 0;
  await import('@/lib/sidedoor/service');
  boundary.fixture!.reset();
  boundary.token = await boundary.fixture!.issue('owner', true); boundary.user = { id: 'owner', isAdmin: true };
  persistence.state!.reset();
  await (await import('@/lib/sidedoor/provider-credentials')).initializeProviderCredentials();
  const { providerVault } = await import('@/lib/sidedoor/provider-credentials');
  const { prisma } = await import('@/lib/prisma');
  await providerVault(prisma).vault.configure('openai', { apiKey: 'saved-openai-key' });
  await boundary.fixture!.access.store.transact(state => { state.initializations.push('flight-finder-platform-v1'); state.principals[0]!.sourceVersion = ''; });
  boundary.upsert.mockImplementation(async ({ update }) => { boundary.config = { ...boundary.config, ...update, updatedAt: new Date(), providerRevision: Number(boundary.config.providerRevision) + 1 }; return boundary.config; });
  boundary.spawn.mockImplementation((_binary: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true; });
    if (args[0] === 'exec') {
      child.stdin.on('finish', () => { writeFileSync(args[args.indexOf('-o') + 1]!, boundary.output); child.emit('close', 0); });
    } else if (args[0] === 'app-server') {
      child.stdin.on('data', chunk => {
        const message = JSON.parse(String(chunk)) as { id?: number };
        if (message.id === undefined) return;
        const result = message.id === 0 ? {} : { data: [{ model: 'gpt-5.6-luna', displayName: 'Luna', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'low' }] }], nextCursor: null };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
      });
    } else queueMicrotask(() => { child.stdout.write('codex-cli 0.153.4'); child.emit('close', 0); });
    return child;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(executableDirectory, { recursive: true, force: true });
});

function request(body: unknown) {
  return new NextRequest('http://localhost:3003/api/admin/config', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3003', host: 'localhost:3003', cookie: `ft-session=${boundary.token}` } });
}

it('validates partial effort changes against the saved provider and model', async () => {
  const { PATCH } = await import('../../app/api/admin/config/route');
  const response = await PATCH(request({ reasoningEffort: 'low' }));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low' });
  expect((await PATCH(request({ reasoningEffort: 'ultra' }))).status).toBe(400);
  expect((await PATCH(request({ model: null }))).status).toBe(400);
});

it('resets inherited effort on provider switches while preserving custom API names', async () => {
  const { PATCH } = await import('../../app/api/admin/config/route');
  const response = await PATCH(request({ provider: 'openai', model: 'org/model@revision' }));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ provider: 'openai', model: 'org/model@revision', reasoningEffort: null });
});

it('allows unrelated settings changes without replacing or rediscovering a stale saved selection', async () => {
  boundary.config.model = 'removed-model';
  boundary.spawn.mockImplementation(() => { throw new Error('CLI unavailable'); });
  const { PATCH } = await import('../../app/api/admin/config/route');
  const response = await PATCH(request({ model: 'removed-model', reasoningEffort: 'default', extractTimeoutSeconds: 120 }));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ model: 'removed-model', extractTimeoutSeconds: 120 });
});

it('closes setup model discovery and tests after setup completes', async () => {
  const route = await import('../../app/api/setup/cli-models/route');
  expect((await route.GET(new Request('http://localhost/api/setup/cli-models?provider=codex'))).status).toBe(403);
  expect((await route.POST(new Request('http://localhost/api/setup/cli-models', { method: 'POST', body: '{}' }))).status).toBe(403);
});

it('rejects anonymous and non-admin household members on model and update endpoints', async () => {
  boundary.token = ''; boundary.user = null;
  boundary.config.multiUserMode = true;
  const route = await import('../../app/api/admin/cli-models/route');
  const updates = await import('../../app/api/admin/cli-models/update/route');
  const get = new Request('http://localhost/api/admin/cli-models?provider=codex');
  expect((await route.GET(get)).status).toBe(401);
  boundary.token = await boundary.fixture!.issue('member'); boundary.user = { id: 'member', isAdmin: false };
  expect((await route.GET(get)).status).toBe(403);
  expect((await route.POST(new Request(get.url, { method: 'POST', body: '{}' }))).status).toBe(403);
  expect((await updates.GET(get)).status).toBe(403);
  expect((await updates.POST(new Request(get.url, { method: 'POST', body: '{"provider":"codex"}' }))).status).toBe(403);
  boundary.user.isAdmin = true;
  await boundary.fixture!.access.store.transact(state => { state.principals.find(principal => principal.id === 'member')!.role = 'owner'; });
  expect((await route.GET(get)).status).toBe(200);
});

it('passes saved model-default thinking through flight parsing into the real CLI adapter', async () => {
  answer(JSON.stringify({ confidence: 'low', parsed: null, ambiguities: [] }));
  const { parseFlightQuery } = await import('./parse-query');
  expect((await parseFlightQuery('Where should I fly?')).response.confidence).toBe('low');
  expect(executionArgs()).toEqual(expect.arrayContaining(['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="medium"']));
});

it.each(['hotel_extract', 'car_extract'])('passes saved effort to shared %s inference', async operation => {
  boundary.config.reasoningEffort = 'low'; answer('{"result":[{"ready":true}]}');
  const { travelJson } = await import('../travel/ai-json');
  expect(await travelJson('Return JSON', 'test', operation)).toEqual({ ready: true });
  expect(executionArgs()).toEqual(expect.arrayContaining(['model_reasoning_effort="low"']));
});

it.each([false, true])('passes thinking through price extraction with override=%s', async override => {
  answer(JSON.stringify([{ travelDate: '2026-11-09', price: 623, currency: 'USD', airline: 'Delta', bookingUrl: 'https://delta.com', stops: 0, duration: '5h 30m' }]));
  const { extractPrices } = await import('./extract-prices');
  const config = override ? { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low' as const, customBaseUrl: null, apiKey: '' } : undefined;
  const result = await extractPrices('Delta $623', 'https://www.google.com/travel/flights', '2026-11-09', undefined, undefined, true, 'google_flights', 'USD', config);
  expect(result.prices[0]).toMatchObject({ price: 623, airline: 'Delta' });
  expect(executionArgs()).toEqual(expect.arrayContaining([`model_reasoning_effort="${override ? 'low' : 'medium'}"`]));
}, 15_000);

it('keeps the admitted preview thinking selection through navigation and extraction', async () => {
  answer(JSON.stringify([{ travelDate: '2026-11-09', price: 623, currency: 'USD', airline: 'Delta', bookingUrl: 'https://delta.com', stops: 0, duration: '5h 30m' }]));
  const { runPreview } = await import('../preview-runner');
  const { withTravelContext } = await import('../travel/context');
  const { TravelVpnSession } = await import('../travel/vpn');
  const lease = { id: 'browser', owner: 'preview-test', generation: 1, topologyVersion: 1 };
  const job = { id: 'preview-test', kind: 'flight_preview', userId: null, status: 'running' } as TravelJob;
  const result = await withTravelContext({ job, lease, config: boundary.config as unknown as ExtractionConfig, vpn: new TravelVpnSession(lease, 'none') }, () => runPreview({
    origins: [{ code: 'JFK', name: 'New York' }], destinations: [{ code: 'LAX', name: 'Los Angeles' }],
    dateFrom: '2026-11-09', dateTo: '2026-11-09', tripType: 'one_way', cabinClass: 'economy', currency: 'USD',
    maxPrice: null, maxStops: null, maxDurationHours: null, preferredAirlines: [], timePreference: 'any',
  }, { concurrency: 1 }));
  expect(result.routes[0]?.flights[0]).toMatchObject({ price: 623, airline: 'Delta' });
  expect(executionArgs()).toEqual(expect.arrayContaining(['model_reasoning_effort="medium"']));
});
