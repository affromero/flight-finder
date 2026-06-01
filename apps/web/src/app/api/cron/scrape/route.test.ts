import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRunScrapeAll = vi.fn();
const mockCleanup = vi.fn();
const mockExpire = vi.fn().mockResolvedValue(0);

vi.mock('@/lib/scraper/run-scrape', () => ({
  runScrapeAll: () => mockRunScrapeAll(),
  cleanupUnvisitedQueries: () => mockCleanup(),
}));

vi.mock('@/lib/scraper/expire-queries', () => ({
  expireDepartedQueries: () => mockExpire(),
}));

import { GET } from './route';

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest('http://localhost/api/cron/scrape', { headers });
}

describe('GET /api/cron/scrape', () => {
  it('rejects request without auth header with 401', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong bearer token with 401', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
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
});
