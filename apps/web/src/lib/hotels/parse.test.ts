import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHotelQuery } from './parse';
import { parseFlightQuery } from '../scraper/parse-query';
import type { createStateBoundary } from '@/test/state-fixture';

const persistence = vi.hoisted(() => ({ state: null as ReturnType<typeof createStateBoundary> | null }));
vi.mock('@/lib/sidedoor/store', async () => {
  const { createStateBoundary } = await import('@/test/state-fixture');
  persistence.state = createStateBoundary();
  return { sharedStateStore: persistence.state.store };
});

const database = vi.hoisted(() => ({ read: vi.fn(), usage: vi.fn(), update: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/prisma', () => {
  const client = { extractionConfig: { findFirst: database.read, findUnique: database.read, update: database.update, upsert: database.upsert }, apiUsageLog: { create: database.usage } };
  return { prisma: { ...client, $transaction: async (operation: (value: typeof client) => Promise<unknown>) => operation(client) } };
});

const checkIn = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
const checkOut = new Date(Date.now() + 63 * 86400000).toISOString().slice(0, 10);
const criteria = { destination: 'London', dateMode: 'fixed', checkIn, checkOut, flexibility: 0, minNights: 3, maxNights: 3,
  rooms: [{ adults: 2, children: [8] }, { adults: 1, children: [] }], currency: 'GBP', sources: ['booking'],
  filters: { maxTotal: 1200, refundable: true, breakfast: true, minStars: 4, minRating: 8, excludedSellers: ['Example seller'], amenities: ['parking'] } };
interface SentRequest { url: string; authorization: string | null; body: Record<string, unknown> }
let requests: SentRequest[];
let writes: unknown[];
let usage: Record<string, unknown>[];
let content: string;
let responseStatus: number;
let finishReason: string;
let changeSelectionDuringRequest: boolean;
const config = { provider: 'openai', model: 'configured-flight-model', customBaseUrl: 'https://hotel-ai.test/v1', extractTimeoutSeconds: 30, openaiRpm: 1000 };

beforeEach(async () => {
  persistence.state!.reset();
  requests = []; writes = []; usage = [];
  content = JSON.stringify({ result: [criteria] });
  responseStatus = 200;
  finishReason = 'stop';
  changeSelectionDuringRequest = false;
  database.read.mockReset().mockResolvedValue({ ...config });
  database.usage.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { usage.push(data); return { id: 'usage' }; });
  database.update.mockReset().mockImplementation(async (value: unknown) => { writes.push(value); throw new Error('Unexpected config mutation'); });
  database.upsert.mockReset().mockImplementation(async (value: unknown) => { writes.push(value); throw new Error('Unexpected config mutation'); });
  const { initializeProviderCredentials, providerVault } = await import('@/lib/sidedoor/provider-credentials');
  await initializeProviderCredentials();
  const { prisma } = await import('@/lib/prisma');
  await providerVault(prisma).vault.configure('openai', {
    apiKey: 'hotel-test-key',
    compatibleApiKey: 'hotel-test-key',
    baseUrl: config.customBaseUrl,
  });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.json() as Record<string, unknown> });
    if (changeSelectionDuringRequest) database.read.mockResolvedValue({ ...config, model: 'newly-selected-model' });
    return Response.json(responseStatus === 200 ? {
      id: 'hotel-completion', object: 'chat.completion', created: 1, model: config.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
    } : { error: { message: 'Configured provider denied this request', type: 'authentication_error', code: 'invalid_api_key' } }, { status: responseStatus });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('natural-language hotel parsing through the provider HTTP boundary', () => {
  it('records the billed flight parser attempt before rejecting malformed JSON, using its original model', async () => {
    content = 'not JSON';
    changeSelectionDuringRequest = true;
    await expect(parseFlightQuery('London to Paris')).rejects.toThrow();
    expect(usage).toEqual([expect.objectContaining({ operation: 'parse-query', provider: 'openai', model: config.model, inputTokens: 90, outputTokens: 30, costUsd: null })]);
  });
  it('returns complete room allocations, dates, and filters while preserving the configured provider and model', async () => {
    const text = `London ${checkIn} to ${checkOut}; one room for two adults and an eight-year-old, another for one adult; refundable with breakfast and parking, four stars, GBP 1200 total`;
    expect(await parseHotelQuery(text)).toEqual(criteria);
    expect(requests).toEqual([expect.objectContaining({ url: 'https://hotel-ai.test/v1/chat/completions', authorization: 'Bearer hotel-test-key', body: expect.objectContaining({ model: config.model, messages: expect.arrayContaining([{ role: 'user', content: text }]) }) })]);
    expect(writes).toEqual([]);
    expect(usage).toEqual([expect.objectContaining({ provider: 'openai', model: config.model, operation: 'hotel_parse', inputTokens: 90, outputTokens: 30 })]);
  });
  it('accepts a result after reasoning text using the canonical JSON reader', async () => {
    content = `<think>Compare [dates] before responding.</think>\n${JSON.stringify({ result: [criteria] })}`;
    expect(await parseHotelQuery('London hotel')).toEqual(criteria);
  });
  it('rejects malformed model output instead of inventing a hotel search', async () => {
    content = '{"result": [invalid JSON';
    await expect(parseHotelQuery('London hotel')).rejects.toThrow(/JSON/);
    expect(writes).toEqual([]);
  });
  it.each([
    ['missing dates', { ...criteria, checkIn: '', checkOut: '' }],
    ['invalid calendar dates', { ...criteria, checkIn: '2099-02-30', checkOut: '2099-03-02' }],
    ['reversed stay dates', { ...criteria, checkIn: checkOut, checkOut: checkIn }],
  ])('rejects %s from the model', async (label, parsed) => {
    content = JSON.stringify({ result: [parsed] });
    await expect(parseHotelQuery('London hotel')).rejects.toThrow(/date|check-in|check-out/i);
  });
  it.each([[null], [8, null]])('requires an age for every child: %j', async (...children) => {
    content = JSON.stringify({ result: [{ ...criteria, rooms: [{ adults: 2, children }] }] });
    await expect(parseHotelQuery('London, two adults and a child')).rejects.toThrow(/Child age/);
  });
  it('rejects multiple proposed searches instead of silently selecting one', async () => {
    content = JSON.stringify({ result: [criteria, { ...criteria, destination: 'Paris' }] });
    await expect(parseHotelQuery('London or Paris')).rejects.toThrow(/one JSON result/);
  });
  it('surfaces provider failure without trying another backend or modifying configuration', async () => {
    responseStatus = 401;
    await expect(parseHotelQuery('London hotel')).rejects.toThrow(/denied/);
    expect(new Set(requests.map(request => request.url))).toEqual(new Set(['https://hotel-ai.test/v1/chat/completions']));
    expect(writes).toEqual([]);
    expect(usage).toEqual([expect.objectContaining({ operation: 'hotel_parse', inputTokens: null, outputTokens: null, costUsd: null, error: expect.any(String) })]);
  });
  it('records measured usage once when a truncated response cannot be used', async () => {
    finishReason = 'length';
    await expect(parseHotelQuery('London hotel')).rejects.toThrow(/did not complete/);
    expect(usage).toEqual([expect.objectContaining({ inputTokens: 90, outputTokens: 30, costUsd: null, error: 'IncompleteGenerationError' })]);
  });
  it('preserves the provider failure when its usage record cannot be stored', async () => {
    responseStatus = 401;
    database.usage.mockRejectedValueOnce(new Error('usage database unavailable'));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(parseHotelQuery('London hotel')).rejects.toThrow(/denied/);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('Failed to record'), expect.any(Error));
    } finally { diagnostic.mockRestore(); }
  });
});
