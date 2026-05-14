import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import type { ParsedFlightQuery } from '../../../../apps/web/src/lib/scraper/parse-query.js';
import type { PriceData } from '../../../../apps/web/src/lib/scraper/extract-prices.js';
import type { RouteResult } from './preview.js';

/**
 * When the instance has multi user mode enabled, CLI created trackers attach
 * to the first admin user so they show up on /account instead of being
 * orphaned (userId = null). Solo mode keeps them unowned, matching today's
 * behavior.
 */
async function resolveOwnerId(): Promise<string | null> {
  const cfg = await prisma.extractionConfig.findUnique({
    where: { id: 'singleton' },
    select: { multiUserMode: true },
  });
  if (!cfg?.multiUserMode) return null;
  const admin = await prisma.user.findFirst({
    where: { isAdmin: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id ?? null;
}

interface RouteSelection {
  route: RouteResult;
  flights: PriceData[];
}

export interface CreatedQuery {
  id: string;
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  date?: string;
  deleteToken: string;
}

export async function createTrackedQueries(
  parsed: ParsedFlightQuery,
  rawInput: string,
  selections: RouteSelection[],
): Promise<CreatedQuery[]> {
  const from = new Date(parsed.dateFrom + 'T00:00:00Z');
  const to = new Date(parsed.dateTo + 'T00:00:00Z');
  const flex = Math.max(0, Math.min(parsed.flexibility || 0, 14));
  const groupId = crypto.randomUUID();
  const ownerId = await resolveOwnerId();

  const results: CreatedQuery[] = [];

  for (const { route, flights } of selections) {
    const deleteToken = crypto.randomUUID();

    const routeFrom = route.date ? new Date(route.date + 'T00:00:00Z') : from;
    const routeTo = route.date ? new Date(route.date + 'T00:00:00Z') : to;
    const routeFlex = route.date ? 0 : flex;
    const routeExpiry = new Date(routeTo);
    routeExpiry.setDate(routeExpiry.getDate() + routeFlex);

    const query = await prisma.query.create({
      data: {
        rawInput,
        origin: route.origin,
        originName: route.originName,
        destination: route.destination,
        destinationName: route.destinationName,
        dateFrom: routeFrom,
        dateTo: routeTo,
        flexibility: routeFlex,
        maxPrice: parsed.maxPrice,
        maxStops: parsed.maxStops,
        preferredAirlines: parsed.preferredAirlines,
        timePreference: parsed.timePreference || 'any',
        cabinClass: parsed.cabinClass || 'economy',
        tripType: parsed.tripType === 'one_way' ? 'one_way' : 'round_trip',
        currency: parsed.currency,
        expiresAt: routeExpiry,
        deleteToken,
        groupId,
        userId: ownerId,
      },
    });

    if (flights.length > 0) {
      await prisma.priceSnapshot.createMany({
        data: flights.map((f) => ({
          queryId: query.id,
          travelDate: new Date(f.travelDate),
          price: f.price,
          currency: f.currency || parsed.currency || 'USD',
          airline: f.airline,
          bookingUrl: f.bookingUrl || '',
          stops: f.stops ?? 0,
          duration: f.duration ?? null,
        })),
      });
    }

    results.push({
      id: query.id,
      origin: route.origin,
      originName: route.originName,
      destination: route.destination,
      destinationName: route.destinationName,
      date: route.date,
      deleteToken,
    });
  }

  return results;
}
