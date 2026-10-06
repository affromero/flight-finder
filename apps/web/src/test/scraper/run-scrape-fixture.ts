import { vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { withTravelContext } from '../../lib/travel/context';
import { TravelVpnSession } from '../../lib/travel/vpn';
import type { ExtractionConfig, TravelJob } from '@/generated/prisma/client';

const { mockPrisma, mockNavigateGoogleFlights, mockNavigateAirlineDirect, mockNavigateSkyscanner, mockNavigateKayak, mockExtractPrices } = vi.hoisted(() => {
  const mockPrisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    travelAdmission: { upsert: vi.fn() },
    query: { findUnique: vi.fn() },
    fetchRun: { create: vi.fn(), update: vi.fn() },
    extractionConfig: { findFirst: vi.fn(), findUnique: vi.fn() },
    priceSnapshot: { createMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), aggregate: vi.fn() },
    queryEditEvent: { findFirst: vi.fn() },
    travelAlertDelivery: { upsert: vi.fn() },
    apiUsageLog: { create: vi.fn() },
  };
  const mockNavigateGoogleFlights = vi.fn();
  const mockNavigateAirlineDirect = vi.fn();
  const mockNavigateSkyscanner = vi.fn();
  const mockNavigateKayak = vi.fn();
  const mockExtractPrices = vi.fn();
  return { mockPrisma, mockNavigateGoogleFlights, mockNavigateAirlineDirect, mockNavigateSkyscanner, mockNavigateKayak, mockExtractPrices };
});

export { mockPrisma, mockNavigateGoogleFlights, mockNavigateAirlineDirect, mockNavigateSkyscanner, mockNavigateKayak, mockExtractPrices };

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }));

vi.mock('../../lib/scraper/navigate', () => ({
  navigateGoogleFlights: (...args: unknown[]) => mockNavigateGoogleFlights(...args),
  navigateAirlineDirect: (...args: unknown[]) => mockNavigateAirlineDirect(...args),
  navigateSkyscanner: (...args: unknown[]) => mockNavigateSkyscanner(...args),
  navigateKayak: (...args: unknown[]) => mockNavigateKayak(...args),
}));

vi.mock('../../lib/scraper/extract-prices', () => ({
  extractPrices: (...args: unknown[]) => mockExtractPrices(...args),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { runScrapeForQuery as scrapeAdmittedQuery } from '../../lib/scraper/run-scrape';

const lease = { id: 'vpn', owner: 'unit-worker', generation: 1, topologyVersion: 1 };
const job = { id: 'unit-job', kind: 'flight_query', queryId: 'q1', userId: null, status: 'running' } as TravelJob;
beforeEach(() => {
  mockPrisma.$transaction.mockImplementation((work: (tx: typeof mockPrisma) => Promise<unknown>) => work(mockPrisma));
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => sql.join('').includes('FROM "TravelJob"') ? [job] : [{ id: 'vpn' }]);
  mockPrisma.travelAdmission.upsert.mockResolvedValue({ quarantinedAt: null, topologyVersion: 1, topologyHash: createHash('sha256').update(JSON.stringify(['none', null, null])).digest('hex') });
  mockPrisma.extractionConfig.findUnique.mockResolvedValue({ vpnProvider: 'none' });
});

// These extraction regressions exercise the admitted pipeline. Queue and worker
// lifecycle behavior is covered separately against PostgreSQL and real browsers.
export async function runScrapeForQuery(...args: Parameters<typeof scrapeAdmittedQuery>) {
  const config = await mockPrisma.extractionConfig.findFirst() as ExtractionConfig | null;
  return withTravelContext({ job, lease, config, vpn: new TravelVpnSession(lease, 'none') }, () => scrapeAdmittedQuery(...args));
}

export const BASE_QUERY = {
  id: 'q1',
  userId: null,
  updatedAt: new Date('2026-01-01'),
  active: true,
  isSeed: false,
  origin: 'JFK',
  destination: 'LAX',
  dateFrom: new Date('2026-06-15'),
  dateTo: new Date('2026-06-20'),
  cabinClass: 'economy',
  tripType: 'round_trip',
  currency: null,
  preferredAirlines: [],
  preferredAggregators: [] as string[],
  maxPrice: null,
  maxStops: null,
  maxDurationHours: null,
  timePreference: 'any',
  flexibility: 0,
  lookAheadDays: 14,
  expiresAt: new Date('2027-01-01'),
  vpnCountries: [],
  user: null as { preferredAggregators: string[] } | null,
};
