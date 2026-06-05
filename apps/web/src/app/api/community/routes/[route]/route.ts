import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiSuccess, apiError } from '@/lib/api-response';
import { cached, redis } from '@/lib/redis';
import { isValidIATA } from '@/lib/iata-codes';
import { getClientIp } from '@/lib/trusted-ip';

// 60 requests per minute per IP. The response is cached for 5 minutes, so
// legitimate browsers will almost never hit this ceiling; it only throttles
// automated scanners that bypass the cache with unique route parameters.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;

async function checkRateLimit(ip: string): Promise<boolean> {
  if (!redis) return true; // fail-open when Redis is unavailable
  const key = `community:route:rl:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    return count <= RATE_LIMIT_MAX;
  } catch {
    return true; // fail-open on Redis errors
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ route: string }> }
) {
  const ip = getClientIp(request);
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Too many requests' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS),
        },
      },
    );
  }

  const { route } = await params;
  const parts = route.split('-');

  if (parts.length !== 2) {
    return apiError('Route must be formatted as ORIGIN-DESTINATION (e.g., JFK-CDG)', 400);
  }

  const [origin, destination] = parts as [string, string];

  if (!isValidIATA(origin) || !isValidIATA(destination)) {
    return apiError('Invalid IATA airport codes', 400);
  }

  const prices = await cached(`community:route:${origin}-${destination}`, async () => {
    const snapshots = await prisma.communitySnapshot.findMany({
      where: { origin, destination },
      select: {
        travelDate: true,
        price: true,
        currency: true,
        airline: true,
        stops: true,
        cabinClass: true,
        scrapedAt: true,
      },
      orderBy: { scrapedAt: 'asc' },
      take: 5000,
    });

    return snapshots.map((s: typeof snapshots[number]) => ({
      travelDate: s.travelDate.toISOString().split('T')[0],
      price: s.price,
      currency: s.currency,
      airline: s.airline,
      stops: s.stops,
      cabinClass: s.cabinClass,
      scrapedAt: s.scrapedAt.toISOString(),
    }));
  }, 300);

  return apiSuccess({ origin, destination, prices });
}
