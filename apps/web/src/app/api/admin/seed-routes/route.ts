import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';

export async function GET() {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const seeds = await prisma.query.findMany({
    where: { isSeed: true },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { snapshots: true, fetchRuns: true } },
      fetchRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { startedAt: true, status: true },
      },
    },
  });

  return apiSuccess(seeds);
}

export async function POST(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const { origin, destination, originName, destinationName, cabinClass, preferredAirlines, lookAheadDays, scrapeInterval } = body;

  if (!origin || !destination || typeof origin !== 'string' || typeof destination !== 'string') {
    return apiError('origin and destination are required', 400);
  }

  const originCode = origin.trim().toUpperCase();
  const destCode = destination.trim().toUpperCase();

  if (originCode.length !== 3 || destCode.length !== 3) {
    return apiError('origin and destination must be 3-letter IATA codes', 400);
  }

  const now = new Date();
  const days = typeof lookAheadDays === 'number' && [7, 14, 21, 30].includes(lookAheadDays) ? lookAheadDays : 14;
  const interval = typeof scrapeInterval === 'number' && [1, 3, 6, 12, 24].includes(scrapeInterval) ? scrapeInterval : 3;

  const seed = await prisma.query.create({
    data: {
      rawInput: `Seed: ${originCode} → ${destCode}`,
      origin: originCode,
      originName: typeof originName === 'string' && originName.trim() ? originName.trim() : originCode,
      destination: destCode,
      destinationName: typeof destinationName === 'string' && destinationName.trim() ? destinationName.trim() : destCode,
      dateFrom: now,
      dateTo: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      cabinClass: typeof cabinClass === 'string' ? cabinClass : 'economy',
      preferredAirlines: Array.isArray(preferredAirlines) ? preferredAirlines : [],
      isSeed: true,
      lookAheadDays: days,
      scrapeInterval: interval,
      expiresAt: new Date('2099-12-31'),
      firstViewedAt: now,
      active: true,
    },
  });

  return apiSuccess(seed, 201);
}
