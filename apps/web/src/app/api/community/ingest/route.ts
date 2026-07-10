import { prisma } from '@/lib/prisma';
import { apiSuccess, apiError } from '@/lib/api-response';
import { isValidIATA } from '@/lib/iata-codes';
import { isValidPriceAmount } from '@/lib/limits';
import { redis } from '@/lib/redis';
import { timingSafeEqual } from 'crypto';

const MAX_BATCH_SIZE = 1000;
const RATE_LIMIT_WINDOW = 3600; // 1 hour per API key

// Snapshot field bounds. Values outside these ranges are almost certainly
// malformed or hostile, so the whole batch is rejected. Prices carry an
// arbitrary currency, and high denomination currencies (COP, JPY, VND) put
// ordinary fares in the millions, so the only price bounds are positive and
// within the shared safe integer ceiling.
const MAX_STOPS = 5;
const MAX_AIRLINE_LEN = 100;
const MAX_CABIN_LEN = 20;
const ALLOWED_CABIN_CLASSES = new Set([
  'economy',
  'premium_economy',
  'business',
  'first',
]);
// travelDate must land in a believable window: airlines do not sell tickets
// years out, and a far-past date is meaningless for a price tracker.
const TRAVEL_PAST_MS = 2 * 365 * 24 * 3600 * 1000; // 2 years back
const TRAVEL_FUTURE_MS = 2 * 365 * 24 * 3600 * 1000; // 2 years ahead

type LimitResult = 'allowed' | 'denied' | 'unavailable';

interface IngestSnapshot {
  origin: string;
  destination: string;
  travelDate: string;
  price: number;
  currency: string;
  airline: string;
  stops: number;
  cabinClass: string;
  scrapedAt: string;
}

async function checkRateLimit(apiKeyId: string): Promise<LimitResult> {
  if (!redis) return 'unavailable';
  const key = `community:ingest:${apiKeyId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW);
    return count <= 1 ? 'allowed' : 'denied'; // 1 request per hour per key
  } catch {
    return 'unavailable';
  }
}

/**
 * Constant-time comparison of two API tokens. Equal-length byte buffers are
 * compared with timingSafeEqual; unequal lengths short-circuit (length is not
 * secret). Used so the authenticated path does not leak key bytes via a
 * variable-time string compare.
 */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: Request) {
  // Authenticate via Bearer token
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return apiError('Missing authorization', 401);
  }

  const token = authHeader.slice(7);
  const apiKeyRecord = await prisma.communityApiKey.findUnique({
    where: { apiKey: token },
  });

  // Always run a constant-time comparison so the not-found path does roughly
  // the same work as the found path, normalizing timing for key existence.
  const stored = apiKeyRecord?.apiKey ?? '';
  const tokenValid = tokensMatch(token, stored) && Boolean(apiKeyRecord?.active);
  if (!apiKeyRecord || !tokenValid) {
    return apiError('Invalid or revoked API key', 401);
  }

  // Rate limit. Fail closed (deny) when Redis cannot be consulted so a cache
  // outage cannot be used to bypass the per-key ingest cap.
  const allowed = await checkRateLimit(apiKeyRecord.id);
  if (allowed === 'unavailable') {
    return apiError('Ingest temporarily unavailable.', 503);
  }
  if (allowed === 'denied') {
    return apiError('Rate limit exceeded. Max 1 request per hour.', 429);
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.snapshots)) {
    return apiError('Invalid payload: expected { snapshots: [...] }', 400);
  }

  const snapshots = body.snapshots as IngestSnapshot[];
  if (snapshots.length > MAX_BATCH_SIZE) {
    return apiError(`Batch too large. Max ${MAX_BATCH_SIZE} snapshots.`, 400);
  }

  const now = new Date();
  const travelMin = new Date(now.getTime() - TRAVEL_PAST_MS);
  const travelMax = new Date(now.getTime() + TRAVEL_FUTURE_MS);
  const valid: {
    origin: string;
    destination: string;
    travelDate: Date;
    price: number;
    currency: string;
    airline: string;
    stops: number;
    cabinClass: string;
    scrapedAt: Date;
    apiKeyId: string;
  }[] = [];
  const errors: string[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i]!;

    // IATA codes must be uppercase A-Z (the validator rejects lowercase, so a
    // permissive client cannot smuggle in unnormalized routes).
    if (typeof s.origin !== 'string' || !isValidIATA(s.origin)) { errors.push(`[${i}] invalid origin: ${s.origin}`); continue; }
    if (typeof s.destination !== 'string' || !isValidIATA(s.destination)) { errors.push(`[${i}] invalid destination: ${s.destination}`); continue; }
    if (typeof s.price !== 'number' || s.price <= 0 || !isValidPriceAmount(s.price)) { errors.push(`[${i}] invalid price: ${s.price}`); continue; }
    if (typeof s.stops !== 'number' || !Number.isInteger(s.stops) || s.stops < 0 || s.stops > MAX_STOPS) { errors.push(`[${i}] invalid stops: ${s.stops}`); continue; }

    const scrapedAt = new Date(s.scrapedAt);
    if (isNaN(scrapedAt.getTime()) || scrapedAt > now) { errors.push(`[${i}] invalid scrapedAt`); continue; }

    const travelDate = new Date(s.travelDate);
    if (isNaN(travelDate.getTime()) || travelDate < travelMin || travelDate > travelMax) { errors.push(`[${i}] invalid travelDate`); continue; }

    if (typeof s.airline !== 'string' || s.airline.length === 0 || s.airline.length > MAX_AIRLINE_LEN) { errors.push(`[${i}] invalid airline`); continue; }

    // cabinClass is constrained to a known enum and a short length so unbounded
    // attacker-controlled strings cannot be persisted.
    const cabinClass = typeof s.cabinClass === 'string' ? s.cabinClass.toLowerCase() : 'economy';
    if (cabinClass.length > MAX_CABIN_LEN || !ALLOWED_CABIN_CLASSES.has(cabinClass)) { errors.push(`[${i}] invalid cabinClass: ${s.cabinClass}`); continue; }

    valid.push({
      origin: s.origin,
      destination: s.destination,
      travelDate,
      price: s.price,
      currency: typeof s.currency === 'string' ? s.currency.toUpperCase().slice(0, 3) : 'USD',
      airline: s.airline.slice(0, MAX_AIRLINE_LEN),
      stops: s.stops,
      cabinClass,
      scrapedAt,
      apiKeyId: apiKeyRecord.id,
    });
  }

  if (valid.length > 0) {
    await prisma.communitySnapshot.createMany({ data: valid });

    // Update API key stats
    await prisma.communityApiKey.update({
      where: { id: apiKeyRecord.id },
      data: {
        lastSeenAt: now,
        snapshotCount: { increment: valid.length },
      },
    });
  }

  return apiSuccess({
    accepted: valid.length,
    rejected: errors.length,
    errors: errors.slice(0, 10), // Only return first 10 errors
  });
}
