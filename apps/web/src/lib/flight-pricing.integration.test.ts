import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from './prisma';
import { detectNewLow } from './notifications/detect';
import { GET as getPrices } from '../app/api/queries/[id]/prices/route';
import { GET as getCommunityRoutes } from '../app/api/community/routes/route';
import { GET as getCommunityPrices } from '../app/api/community/routes/[route]/route';
import { syncToHub } from './community-sync';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

describe.skipIf(process.env.FLIGHT_PRICING_INTEGRATION_TESTS !== '1')('actual flight fares in PostgreSQL', () => {
  let queryId = '';
  let apiKeyId = '';
  const cycle = new Date();
  const travelDate = new Date(cycle.getTime() + 60 * 86_400_000);
  const earlier = new Date(cycle.getTime() - 60_000);
  const legacyAirline = 'Air Canada + Air Canada (approx OW+OW)';

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55416' || url.pathname !== '/flight_test') {
      throw new Error('Pricing integration tests require disposable localhost:55416/flight_test');
    }
    if (process.env.REDIS_URL) throw new Error('Pricing integration tests require Redis disabled');
    if (await prisma.communitySnapshot.count()) throw new Error('Pricing integration tests require an empty community dataset');
    queryId = (await prisma.query.create({ data: {
      rawInput: 'issue 216 integration', origin: 'YUL', originName: 'Montreal', destination: 'NRT', destinationName: 'Tokyo',
      dateFrom: travelDate, dateTo: new Date(travelDate.getTime() + 15 * 86_400_000),
      expiresAt: new Date(travelDate.getTime() + 16 * 86_400_000), currency: 'CAD',
    } })).id;
    await prisma.priceSnapshot.createMany({ data: [
      { queryId, travelDate, price: 2991, airline: legacyAirline, currency: 'CAD', scrapedAt: earlier },
      { queryId, travelDate, price: 1809, airline: 'Air Canada', currency: 'CAD', scrapedAt: cycle },
    ] });
    apiKeyId = (await prisma.communityApiKey.create({ data: { apiKey: `pricing-test-${crypto.randomUUID()}` } })).id;
    await prisma.communitySnapshot.createMany({ data: [
      { origin: 'YUL', destination: 'NRT', travelDate, price: 999, currency: 'CAD', airline: legacyAirline, stops: 0, cabinClass: 'economy', scrapedAt: earlier, apiKeyId },
      { origin: 'YUL', destination: 'NRT', travelDate, price: 1809, currency: 'CAD', airline: 'Air Canada', stops: 0, cabinClass: 'economy', scrapedAt: cycle, apiKeyId },
    ] });
  });

  afterAll(async () => {
    if (queryId) await prisma.query.delete({ where: { id: queryId } });
    if (apiKeyId) {
      await prisma.communitySnapshot.deleteMany({ where: { apiKeyId } });
      await prisma.communityApiKey.delete({ where: { id: apiKeyId } });
    }
    await prisma.$disconnect();
  });

  it('returns actual price history while retaining the excluded estimate in storage', async () => {
    const response = await getPrices(new NextRequest(`http://localhost/api/queries/${queryId}/prices`), { params: Promise.resolve({ id: queryId }) });
    const body = await response.json();
    expect(body.data.snapshots.map((snapshot: { price: number }) => snapshot.price)).toEqual([1809]);
    expect(body.data).toMatchObject({ snapshotCount: 1, totalSnapshotCount: 1 });
    expect(await prisma.priceSnapshot.count({ where: { queryId } })).toBe(2);
  });

  it('prints actual fares through the built CLI detail and list commands', async () => {
    const executable = fileURLToPath(new URL('../../../../packages/cli/dist/index.js', import.meta.url));
    const run = (args: string[]) => promisify(execFile)(process.execPath, [executable, '--json', ...args], { timeout: 15_000 });
    const detailOutput = await run(['--view', queryId]);
    expect(detailOutput.stderr).toBe('');
    const detail = JSON.parse(detailOutput.stdout);
    expect(detail).toMatchObject({ bestPrice: { price: 1809, airline: 'Air Canada' }, snapshotCount: 1 });
    const listOutput = await run([]);
    expect(listOutput.stderr).toBe('');
    const summary = JSON.parse(listOutput.stdout).find((row: { id: string }) => row.id === queryId);
    expect(summary).toMatchObject({ minPrice: 1809, maxPrice: 1809, snapshotCount: 1 });
  });

  it('establishes a real baseline silently when the only prior price was a two-ticket estimate', async () => {
    expect(await detectNewLow({ query: { id: queryId, currency: 'CAD', lastNotifiedLowPrice: null }, cycleStartedAt: cycle, floorAbs: 5, floorPct: 0 })).toBeNull();
  });

  it('compares actual fares even when a newer estimate is cheaper', async () => {
    const prior = await prisma.priceSnapshot.create({ data: { queryId, travelDate, price: 2000, airline: 'Air Canada', currency: 'CAD', scrapedAt: earlier } });
    const estimate = await prisma.priceSnapshot.create({ data: { queryId, travelDate, price: 999, airline: legacyAirline, currency: 'CAD', scrapedAt: cycle } });
    try {
      const alert = await detectNewLow({ query: { id: queryId, currency: 'CAD', lastNotifiedLowPrice: null }, cycleStartedAt: cycle, floorAbs: 5, floorPct: 0 });
      expect(alert).toMatchObject({ currentMin: 1809, baseline: 2000, drop: 191, airline: 'Air Canada' });
    } finally {
      await prisma.priceSnapshot.deleteMany({ where: { id: { in: [prior.id, estimate.id] } } });
    }
  });

  it('shares only actual fares with the community hub', async () => {
    const previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { communitySharing: true, communityApiKey: true, lastCommunitySyncAt: true } });
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' },
      create: { communitySharing: true, communityApiKey: 'local-test-token' },
      update: { communitySharing: true, communityApiKey: 'local-test-token', lastCommunitySyncAt: null },
    });
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await syncToHub();
      const request = fetchBoundary.mock.calls[0]?.[1];
      const payload = JSON.parse(String(request?.body));
      expect(payload.snapshots.map((snapshot: { price: number }) => snapshot.price)).toEqual([1809]);
    } finally {
      fetchBoundary.mockRestore();
      if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previous });
      else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    }
  });

  it('excludes existing community estimates from grouped minima, averages, counts, and history', async () => {
    const summary = await (await getCommunityRoutes()).json();
    expect(summary.data).toEqual([expect.objectContaining({
      origin: 'YUL', destination: 'NRT', snapshotCount: 1, minPrice: 1809, maxPrice: 1809, avgPrice: 1809, airlines: ['Air Canada'],
    })]);
    const response = await getCommunityPrices(new NextRequest('http://localhost/api/community/routes/YUL-NRT'), { params: Promise.resolve({ route: 'YUL-NRT' }) });
    const body = await response.json();
    expect(body.data.prices.map((snapshot: { price: number }) => snapshot.price)).toEqual([1809]);
    expect(await prisma.communitySnapshot.count({ where: { apiKeyId } })).toBe(2);
  });
});
