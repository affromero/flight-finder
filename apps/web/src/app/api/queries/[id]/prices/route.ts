import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { cached } from '@/lib/redis';
import { filterSnapshotsByTrackerFilters } from '@/lib/snapshot-filters';
import { MAX_TRACKER_EDIT_EVENTS } from '@/lib/tracker-edit-events';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const query = await prisma.query.findUnique({
    where: { id },
    select: {
      id: true,
      origin: true,
      originName: true,
      destination: true,
      destinationName: true,
      dateFrom: true,
      dateTo: true,
      flexibility: true,
      maxPrice: true,
      maxStops: true,
      maxDurationHours: true,
      preferredAirlines: true,
      timePreference: true,
      cabinClass: true,
      tripType: true,
      currency: true,
      expiresAt: true,
      createdAt: true,
      active: true,
      scrapeInterval: true,
    },
  });

  const globalConfig = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { scrapeInterval: true },
  });

  if (!query) {
    return apiError('Query not found', 404);
  }

  if (new Date() > query.expiresAt) {
    return apiError('This tracker has expired', 410);
  }

  // Fetch the most recent MAX_SNAPSHOTS snapshots (desc), then reverse so the
  // result is chronological (asc) for chart rendering. This bounds the payload
  // for queries with a very long history while keeping the most relevant data.
  const MAX_SNAPSHOTS = 5000;

  const snapshotsDesc = await cached(
    `ft:prices:${id}`,
    () =>
      prisma.priceSnapshot.findMany({
        where: { queryId: id },
        orderBy: { scrapedAt: 'desc' },
        take: MAX_SNAPSHOTS,
        select: {
          id: true,
          travelDate: true,
          price: true,
          currency: true,
          airline: true,
          bookingUrl: true,
          stops: true,
          duration: true,
          flightId: true,
          flightNumber: true,
          departureTime: true,
          arrivalTime: true,
          seatsLeft: true,
          status: true,
          airlineDirectPrice: true,
          vpnCountry: true,
          scrapedAt: true,
        },
      }),
    120 // 2 min cache for public page
  );

  const allSnapshots = snapshotsDesc.slice().reverse();
  const snapshots = filterSnapshotsByTrackerFilters(allSnapshots, query);

  const [lastRun, editEventsDesc] = await Promise.all([
    prisma.fetchRun.findFirst({
      where: { queryId: id },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true },
    }),
    prisma.queryEditEvent.findMany({
      where: { queryId: id },
      orderBy: { editedAt: 'desc' },
      take: MAX_TRACKER_EDIT_EVENTS,
      select: { id: true, editedAt: true, summary: true, changes: true },
    }),
  ]);
  const editEvents = editEventsDesc.slice().reverse();

  const effectiveInterval = query.scrapeInterval ?? globalConfig?.scrapeInterval ?? 3;

  return apiSuccess({
    query,
    snapshots,
    lastChecked: lastRun?.startedAt ?? null,
    lastStatus: lastRun?.status ?? null,
    snapshotCount: snapshots.length,
    totalSnapshotCount: allSnapshots.length,
    editEvents,
    effectiveInterval,
  });
}
