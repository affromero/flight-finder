import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExtractionFindFirst = vi.fn();
const mockExtractionUpdate = vi.fn();
const mockQueryFindUnique = vi.fn();
const mockQueryUpdate = vi.fn();
const mockQueryUpdateMany = vi.fn();
const mockDetectNewLow = vi.fn();
const mockDispatch = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extractionConfig: {
      findFirst: (...a: unknown[]) => mockExtractionFindFirst(...a),
      update: (...a: unknown[]) => mockExtractionUpdate(...a),
    },
    query: {
      findUnique: (...a: unknown[]) => mockQueryFindUnique(...a),
      update: (...a: unknown[]) => mockQueryUpdate(...a),
      updateMany: (...a: unknown[]) => mockQueryUpdateMany(...a),
    },
  },
}));
vi.mock('./detect', () => ({ detectNewLow: (...a: unknown[]) => mockDetectNewLow(...a) }));
vi.mock('./notify', () => ({ dispatchNotifications: (...a: unknown[]) => mockDispatch(...a) }));

import { notifyNewLows, resolveBaseUrl } from './run';

const ALERT = {
  queryId: 'q1',
  currentMin: 250,
  baseline: 300,
  drop: 50,
  currency: 'USD',
  airline: 'United',
  bookingUrl: null,
  travelDate: new Date('2026-08-01T00:00:00Z'),
  flightNumber: null,
};
const CYCLE = new Date('2026-06-04T00:00:00Z');
const CUTOFF = new Date('2026-06-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractionFindFirst.mockResolvedValue({ id: 'singleton', notifyMinDropAbs: 5, notifyMinDropPct: 0, publicBaseUrl: 'https://x.example', cabinAlertBaselineCutoff: CUTOFF });
  mockExtractionUpdate.mockResolvedValue({});
  mockQueryFindUnique.mockResolvedValue({ id: 'q1', origin: 'MAD', destination: 'JFK', currency: 'USD', userId: null, lastNotifiedLowPrice: null, cabinClass: 'economy' });
  mockDetectNewLow.mockResolvedValue(ALERT);
  mockQueryUpdate.mockResolvedValue({});
  mockQueryUpdateMany.mockResolvedValue({ count: 0 });
});

describe('notifyNewLows dedupe marker', () => {
  it('advances when at least one channel delivers', async () => {
    mockDispatch.mockResolvedValue([{ channelId: 'c1', type: 'telegram', ok: true }]);
    await notifyNewLows(['q1'], CYCLE);
    expect(mockQueryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1' }, data: expect.objectContaining({ lastNotifiedLowPrice: 250 }) }),
    );
  });

  it('does NOT advance when every channel fails (so the retry survives)', async () => {
    mockDispatch.mockResolvedValue([{ channelId: 'c1', type: 'telegram', ok: false, error: 'boom' }]);
    await notifyNewLows(['q1'], CYCLE);
    expect(mockQueryUpdate).not.toHaveBeenCalled();
  });

  it('does NOT advance when there are no channels configured', async () => {
    mockDispatch.mockResolvedValue([]);
    await notifyNewLows(['q1'], CYCLE);
    expect(mockQueryUpdate).not.toHaveBeenCalled();
  });

  it('skips a query with no new low', async () => {
    mockDetectNewLow.mockResolvedValue(null);
    await notifyNewLows(['q1'], CYCLE);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockQueryUpdate).not.toHaveBeenCalled();
  });

  it('isolates a per-query failure and keeps processing the rest', async () => {
    mockQueryFindUnique.mockRejectedValueOnce(new Error('db blip'));
    mockQueryFindUnique.mockResolvedValueOnce({ id: 'q2', origin: 'LHR', destination: 'JFK', currency: 'USD', userId: null, lastNotifiedLowPrice: null });
    mockDispatch.mockResolvedValue([{ channelId: 'c1', type: 'telegram', ok: true }]);
    await notifyNewLows(['q1', 'q2'], CYCLE);
    expect(mockDispatch).toHaveBeenCalledTimes(1); // q2 still ran
  });
});

describe('notifyNewLows cabin baseline cutoff (pre-fix Economy fares mislabeled as premium cabins)', () => {
  it('arms the cutoff once and clears poisoned dedupe markers on non-economy queries', async () => {
    mockExtractionFindFirst.mockResolvedValue({ id: 'singleton', notifyMinDropAbs: 5, notifyMinDropPct: 0, cabinAlertBaselineCutoff: null });
    mockDispatch.mockResolvedValue([]);
    await notifyNewLows(['q1'], CYCLE);
    expect(mockExtractionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { cabinAlertBaselineCutoff: expect.any(Date) } }),
    );
    expect(mockQueryUpdateMany).toHaveBeenCalledWith({
      where: { cabinClass: { not: 'economy' } },
      data: { lastNotifiedLowPrice: null, lastNotifiedAt: null },
    });
  });

  it('does not re-arm when the cutoff is already set', async () => {
    mockDispatch.mockResolvedValue([]);
    await notifyNewLows(['q1'], CYCLE);
    expect(mockExtractionUpdate).not.toHaveBeenCalled();
    expect(mockQueryUpdateMany).not.toHaveBeenCalled();
  });

  it('bounds the baseline for non-economy queries and leaves economy unbounded', async () => {
    mockDispatch.mockResolvedValue([]);
    mockQueryFindUnique
      .mockResolvedValueOnce({ id: 'q1', origin: 'MAD', destination: 'JFK', currency: 'USD', userId: null, lastNotifiedLowPrice: null, cabinClass: 'business' })
      .mockResolvedValueOnce({ id: 'q2', origin: 'MAD', destination: 'JFK', currency: 'USD', userId: null, lastNotifiedLowPrice: null, cabinClass: 'economy' });
    await notifyNewLows(['q1', 'q2'], CYCLE);
    expect(mockDetectNewLow.mock.calls[0]![0].baselineFrom).toEqual(CUTOFF);
    expect(mockDetectNewLow.mock.calls[1]![0].baselineFrom).toBeNull();
  });
});

describe('resolveBaseUrl', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.SELF_HOSTED;
  });
  afterEach(() => {
    process.env = { ...prev };
  });

  it('prefers the admin-configured publicBaseUrl', () => {
    expect(resolveBaseUrl('https://mine.example/')).toBe('https://mine.example');
  });

  it('falls back to APP_URL when publicBaseUrl is null', () => {
    process.env.APP_URL = 'https://env.example';
    expect(resolveBaseUrl(null)).toBe('https://env.example');
  });

  it('returns null on a self-hosted instance with nothing configured (no wrong link)', () => {
    process.env.SELF_HOSTED = 'true';
    expect(resolveBaseUrl(null)).toBeNull();
  });

  it('falls back to the hosted site only when not self-hosted', () => {
    expect(resolveBaseUrl(null)).toBe('https://flight-finder.org');
  });
});
