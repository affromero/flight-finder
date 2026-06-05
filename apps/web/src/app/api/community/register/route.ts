import { prisma } from '@/lib/prisma';
import { apiSuccess, apiError } from '@/lib/api-response';
import { randomBytes } from 'crypto';
import { redis } from '@/lib/redis';
import { getClientIp } from '@/lib/trusted-ip';

const RATE_LIMIT_WINDOW = 3600; // 1 hour
const RATE_LIMIT_MAX = 5; // max registrations per IP per hour

const GLOBAL_WINDOW = 24 * 3600; // 1 day
const GLOBAL_MAX = 200; // max keys minted across all IPs per day

type LimitResult = 'allowed' | 'denied' | 'unavailable';

async function checkRateLimit(ip: string): Promise<LimitResult> {
  if (!redis) return 'unavailable';
  const key = `community:register:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW);
    return count <= RATE_LIMIT_MAX ? 'allowed' : 'denied';
  } catch {
    return 'unavailable';
  }
}

async function checkGlobalCap(): Promise<LimitResult> {
  if (!redis) return 'unavailable';
  const key = 'community:register:global';
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, GLOBAL_WINDOW);
    return count <= GLOBAL_MAX ? 'allowed' : 'denied';
  } catch {
    return 'unavailable';
  }
}

export async function POST(request: Request) {
  // Registration is an opt-in, admin-enabled feature. Off by default so a
  // public deployment never mints keys unless the operator turns it on, either
  // from the admin UI (ExtractionConfig.communityRegistrationOpen) or the
  // COMMUNITY_REGISTRATION_OPEN env override.
  const config = await prisma.extractionConfig.findUnique({
    where: { id: 'singleton' },
    select: { communityRegistrationOpen: true },
  });
  const open =
    config?.communityRegistrationOpen === true ||
    process.env.COMMUNITY_REGISTRATION_OPEN === 'true';
  if (!open) {
    return apiError('Community registration is disabled.', 403);
  }

  const ip = getClientIp(request);

  // Per-IP throttle and global daily cap. Both fail closed (deny) when Redis
  // cannot be consulted so key minting stays bounded during an outage.
  const perIp = await checkRateLimit(ip);
  if (perIp === 'unavailable') {
    return apiError('Registration temporarily unavailable.', 503);
  }
  if (perIp === 'denied') {
    return apiError('Too many registrations. Try again later.', 429);
  }

  const global = await checkGlobalCap();
  if (global === 'unavailable') {
    return apiError('Registration temporarily unavailable.', 503);
  }
  if (global === 'denied') {
    return apiError('Registration is at capacity. Try again later.', 429);
  }

  const apiKey = `ft_${randomBytes(32).toString('hex')}`;

  await prisma.communityApiKey.create({
    data: { apiKey },
  });

  return apiSuccess({ apiKey });
}
