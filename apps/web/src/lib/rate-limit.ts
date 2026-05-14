import { redis } from '@/lib/redis';

const DEFAULT_TTL_SECONDS = 15 * 60; // 15 minutes
const KEY_PREFIX = 'auth-fail:';

/**
 * Rate limit key extraction trusts the x-forwarded-for header as set by the
 * deployment's reverse proxy (Caddy / nginx / Cloudflare). On the typical
 * self-hosted setup the app is reachable only from the LAN behind Caddy
 * (docker-compose.prod.yml), so spoofing requires already being inside the
 * trust boundary. For deployments without a trusted proxy, set
 * TRUSTED_FORWARDED_FOR=false to fall back to the connection-level IP.
 */

/**
 * Increments the failure counter for `key`. Returns the new count, or 0 if
 * Redis is unavailable (fail-open so login still works during outages).
 */
export async function incrementAuthFailure(
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<number> {
  if (!redis) return 0;
  const fullKey = `${KEY_PREFIX}${key}`;
  try {
    const count = await redis.incr(fullKey);
    if (count === 1) {
      await redis.expire(fullKey, ttlSeconds);
    }
    return count;
  } catch {
    return 0;
  }
}

export async function getAuthFailureCount(key: string): Promise<number> {
  if (!redis) return 0;
  try {
    const v = await redis.get(`${KEY_PREFIX}${key}`);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

export async function getRetryAfterSeconds(key: string): Promise<number> {
  if (!redis) return 0;
  try {
    const ttl = await redis.ttl(`${KEY_PREFIX}${key}`);
    return ttl > 0 ? ttl : 0;
  } catch {
    return 0;
  }
}

export async function clearAuthFailures(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`${KEY_PREFIX}${key}`);
  } catch {
    // Ignore; counter will TTL out
  }
}
