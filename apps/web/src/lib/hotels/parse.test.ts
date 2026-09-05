import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHotelQuery } from './parse';

const database = vi.hoisted(() => ({ read: vi.fn(), usage: vi.fn(), update: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { extractionConfig: { findFirst: database.read, update: database.update, upsert: database.upsert }, apiUsageLog: { create: database.usage } } }));

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
const config = { provider: 'openai', model: 'configured-flight-model', customBaseUrl: 'https://hotel-ai.test/v1', extractTimeoutSeconds: 30, openaiRpm: 1000 };

beforeEach(() => {
  requests = []; writes = []; usage = [];
  content = JSON.stringify({ result: [criteria] });
  responseStatus = 200;
  database.read.mockReset().mockResolvedValue({ ...config });
  database.usage.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { usage.push(data); return { id: 'usage' }; });
  database.update.mockReset().mockImplementation(async (value: unknown) => { writes.push(value); throw new Error('Unexpected config mutation'); });
  database.upsert.mockReset().mockImplementation(async (value: unknown) => { writes.push(value); throw new Error('Unexpected config mutation'); });
  vi.stubEnv('OPENAI_API_KEY', 'hotel-test-key');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.json() as Record<string, unknown> });
    return Response.json(responseStatus === 200 ? {
      id: 'hotel-completion', object: 'chat.completion', created: 1, model: config.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
    } : { error: { message: 'Configured provider denied this request', type: 'authentication_error', code: 'invalid_api_key' } }, { status: responseStatus });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('natural-language hotel parsing through the provider HTTP boundary', () => {
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
  it('requires an age for each child instead of accepting an unspecified age', async () => {
    content = JSON.stringify({ result: [{ ...criteria, rooms: [{ adults: 2, children: [null] }] }] });
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
    expect(usage).toEqual([]);
  });
});
