import { prisma } from '@/lib/prisma';
import { cached, redis } from '@/lib/redis';

const CACHE_KEY = 'ft:multi-user';
const TTL_SECONDS = 60;

/**
 * Self-hosted only feature. When SELF_HOSTED is unset (flight-finder.org or any
 * hosted deployment), this always returns false regardless of the DB value —
 * this protects against accidental activation if a self-hosted DB dump is
 * restored on top of a hosted instance.
 */
export async function isMultiUserEnabled(): Promise<boolean> {
  if (process.env.SELF_HOSTED !== 'true') return false;
  return cached(
    CACHE_KEY,
    async () => {
      const cfg = await prisma.extractionConfig.findUnique({
        where: { id: 'singleton' },
        select: { multiUserMode: true },
      });
      return Boolean(cfg?.multiUserMode);
    },
    TTL_SECONDS,
  );
}

export async function invalidateMultiUserCache(): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(CACHE_KEY);
  } catch {
    // Redis unavailable; next read falls through to DB anyway
  }
}
