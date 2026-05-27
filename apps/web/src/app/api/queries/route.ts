import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { isAggregatorSource } from '@/lib/scraper/navigate';

interface RouteInput {
  origin: string;
  originName: string;
  destination: string;
  destinationName: string;
  date?: string; // when set, pins this query to a specific outbound date
  returnDate?: string; // when set, pins return date for round trips
  selectedFlights: Array<{
    travelDate: string;
    price: number;
    currency?: string;
    airline: string;
    bookingUrl: string | null;
    stops?: number;
    duration?: string | null;
    flightNumber?: string | null;
  }>;
}

export async function POST(request: NextRequest) {
  const multiUser = await isMultiUserEnabled();
  const currentUser = multiUser ? await getCurrentUser() : null;
  if (multiUser && !currentUser) {
    return apiError('Sign in to create a tracker', 401);
  }

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const {
    rawInput,
    dateFrom,
    dateTo,
    flexibility,
    maxPrice,
    maxStops,
    maxDurationHours,
    preferredAirlines,
    timePreference,
    cabinClass,
    tripType,
    currency: bodyCurrency,
    vpnCountries: bodyVpnCountries,
  } = body;
  const currency: string | null = typeof bodyCurrency === 'string' && bodyCurrency ? bodyCurrency : null;

  // Validate maxDurationHours: integer between 1 and 48 hours, or null.
  let maxDurationHoursValidated: number | null = null;
  if (maxDurationHours !== undefined && maxDurationHours !== null) {
    const n = Number(maxDurationHours);
    if (!Number.isInteger(n) || n < 1 || n > 48) {
      return apiError('maxDurationHours must be an integer between 1 and 48', 400);
    }
    maxDurationHoursValidated = n;
  }
  const vpnCountries: string[] = Array.isArray(bodyVpnCountries)
    ? bodyVpnCountries.filter((c: unknown) => typeof c === 'string' && /^[A-Z]{2}$/.test(c))
    : [];

  // Support both new (routes array) and legacy (single origin/destination) formats
  let routeInputs: RouteInput[];

  if (Array.isArray(body.routes) && body.routes.length > 0) {
    routeInputs = body.routes;
  } else if (body.origin && body.destination) {
    // Legacy single-route format
    routeInputs = [{
      origin: body.origin,
      originName: body.originName || body.origin,
      destination: body.destination,
      destinationName: body.destinationName || body.destination,
      selectedFlights: Array.isArray(body.selectedFlights) ? body.selectedFlights : [],
    }];
  } else {
    return apiError('Missing required fields: routes array or origin/destination', 400);
  }

  if (!rawInput || !dateFrom || !dateTo) {
    return apiError('Missing required fields: rawInput, dateFrom, dateTo', 400);
  }

  // Validate all route airport codes
  for (const route of routeInputs) {
    if (!/^[A-Z]{3}$/.test(route.origin) || !/^[A-Z]{3}$/.test(route.destination)) {
      return apiError(`Invalid airport code in route ${route.origin}→${route.destination}`, 400);
    }
  }

  const from = new Date(dateFrom + 'T00:00:00Z');
  const to = new Date(dateTo + 'T00:00:00Z');

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return apiError('Invalid date format', 400);
  }

  const isOneWay = tripType === 'one_way';
  if (!isOneWay && from >= to) {
    return apiError('dateFrom must be before dateTo', 400);
  }

  const flex = Math.max(0, Math.min(Number(flexibility) || 0, 14));
  const expiresAt = new Date(to);
  expiresAt.setDate(expiresAt.getDate() + flex);

  const airlines: string[] = Array.isArray(preferredAirlines) ? preferredAirlines : [];

  // preferredAggregators is optional on creation; empty means inherit user/admin defaults.
  let aggregators: string[] = [];
  if (Array.isArray(body.preferredAggregators)) {
    for (const a of body.preferredAggregators) {
      if (!isAggregatorSource(a)) {
        return apiError(`preferredAggregators contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    aggregators = body.preferredAggregators;
  }

  let label: string | null = null;
  if (typeof body.label === 'string') {
    const trimmed = body.label.trim();
    if (trimmed.length > 60) {
      return apiError('label must be 60 characters or fewer', 400);
    }
    label = trimmed || null;
  }

  const groupId = crypto.randomUUID();

  const results: Array<{
    id: string;
    origin: string;
    originName: string;
    destination: string;
    destinationName: string;
    date?: string;
    returnDate?: string;
    deleteToken: string;
    label: string | null;
  }> = [];

  for (const route of routeInputs) {
    const flights = route.selectedFlights || [];

    const deleteToken = crypto.randomUUID();

    // Per-date pinning: when route has a specific date, pin dateFrom to outbound and dateTo to return
    const routeFrom = route.date ? new Date(route.date + 'T00:00:00Z') : from;
    const routeTo = route.returnDate ? new Date(route.returnDate + 'T00:00:00Z') : (route.date ? new Date(route.date + 'T00:00:00Z') : to);
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
        maxPrice: maxPrice ? Number(maxPrice) : null,
        maxStops: maxStops !== undefined && maxStops !== null ? Number(maxStops) : null,
        maxDurationHours: maxDurationHoursValidated,
        preferredAirlines: airlines,
        preferredAggregators: aggregators,
        label,
        timePreference: timePreference || 'any',
        cabinClass: cabinClass || 'economy',
        tripType: tripType === 'one_way' ? 'one_way' : 'round_trip',
        currency,
        vpnCountries,
        expiresAt: routeExpiry,
        firstViewedAt: new Date(),
        deleteToken,
        groupId,
        userId: currentUser?.id ?? null,
      },
    });

    if (flights.length > 0) {
      await prisma.priceSnapshot.createMany({
        data: flights.map((f) => ({
          queryId: query.id,
          travelDate: new Date(f.travelDate),
          price: f.price,
          currency: f.currency || 'USD',
          airline: f.airline,
          bookingUrl: f.bookingUrl || '',
          stops: f.stops ?? 0,
          duration: f.duration ?? null,
          flightNumber: f.flightNumber ?? null,
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
      returnDate: route.returnDate,
      deleteToken,
      label,
    });
  }

  // Fire immediate scrape for all created queries including VPN passes (background, non-blocking)
  const { runFullScrapeForQuery } = await import('@/lib/scraper/run-scrape');
  for (const q of results) {
    runFullScrapeForQuery(q.id).catch((err) => {
      console.error(`[queries] background scrape failed for ${q.id}:`, err instanceof Error ? err.message : err);
    });
  }

  return apiSuccess({ queries: results }, 201);
}
