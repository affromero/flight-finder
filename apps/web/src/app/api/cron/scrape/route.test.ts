import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockRunScrapeAll = vi.fn();
const mockCleanup = vi.fn();
const mockExpire = vi.fn().mockResolvedValue(0);
const mockNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/scraper/run-scrape', () => ({
  runScrapeAll: () => mockRunScrapeAll(),
  cleanupUnvisitedQueries: () => mockCleanup(),
}));

vi.mock('@/lib/scraper/expire-queries', () => ({
  expireDepartedQueries: () => mockExpire(),
}));

vi.mock('@/lib/notifications/run', () => ({
  notifyNewLows: (...args: unknown[]) => mockNotify(...args),
}));

import { GET } from './route';

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest('http://localhost/api/cron/scrape', { headers });
}

describe('GET /api/cron/scrape', () => {
  beforeEach(() => {
    mockNotify.mockReset();
    mockNotify.mockResolvedValue(undefined);
  });

  it('rejects request without auth header with 401', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong bearer token with 401', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('rejects "Bearer undefined" when CRON_SECRET is unset', async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      // An attacker sending the literal string "Bearer undefined" must be blocked
      // even though that is what the old code would have accepted.
      const req = new NextRequest('http://localhost/api/cron/scrape', {
        headers: { authorization: 'Bearer undefined' },
      });
      const res = await GET(req);
      expect(res.status).toBe(401);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  it('runs scrape and returns summary on valid auth', async () => {
    mockCleanup.mockResolvedValue(2);
    mockExpire.mockResolvedValue(4);
    mockRunScrapeAll.mockResolvedValue([
      { status: 'success', snapshotsCount: 5, extractionCost: 0.01 },
      { status: 'failed', snapshotsCount: 0, extractionCost: 0 },
    ]);

    const res = await GET(makeRequest('test-cron-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.queriesProcessed).toBe(2);
    expect(body.data.successful).toBe(1);
    expect(body.data.failed).toBe(1);
    expect(body.data.totalSnapshots).toBe(5);
    expect(body.data.expiredDeparted).toBe(4);
  });

  it('includes cleanup count in response', async () => {
    mockCleanup.mockResolvedValue(3);
    mockRunScrapeAll.mockResolvedValue([]);

    const res = await GET(makeRequest('test-cron-secret'));
    const body = await res.json();
    expect(body.data.deletedUnvisited).toBe(3);
  });

  it('runs the new-low notification pass for successful queries only', async () => {
    mockCleanup.mockResolvedValue(0);
    mockExpire.mockResolvedValue(0);
    mockRunScrapeAll.mockResolvedValue([
      { queryId: 'q-ok', status: 'success', snapshotsCount: 5, extractionCost: 0.01 },
      { queryId: 'q-bad', status: 'failed', snapshotsCount: 0, extractionCost: 0 },
    ]);

    const res = await GET(makeRequest('test-cron-secret'));
    expect(res.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledWith(['q-ok'], expect.any(Date));
  });

  it('still returns 200 when the notification pass throws', async () => {
    mockCleanup.mockResolvedValue(0);
    mockExpire.mockResolvedValue(0);
    mockRunScrapeAll.mockResolvedValue([
      { queryId: 'q-ok', status: 'success', snapshotsCount: 1, extractionCost: 0 },
    ]);
    mockNotify.mockRejectedValue(new Error('telegram down'));

    const res = await GET(makeRequest('test-cron-secret'));
    expect(res.status).toBe(200);
  });
});
