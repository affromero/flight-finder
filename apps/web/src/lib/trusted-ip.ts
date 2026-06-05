import type { NextRequest } from 'next/server';

/**
 * Client IP extraction with an explicit trust switch for the x-forwarded-for
 * header.
 *
 * The x-forwarded-for / x-real-ip headers are client-controllable. They are
 * only trustworthy when a reverse proxy in front of the app (Caddy / nginx /
 * Cloudflare) overwrites or appends them. On the typical self-hosted setup the
 * app is reachable only from the LAN behind Caddy (docker-compose.prod.yml),
 * so the proxy is the trust boundary and the first forwarded entry is the
 * real client.
 *
 * TRUSTED_FORWARDED_FOR controls the behavior:
 *   - unset or 'true' (default): trust the proxy. Read the FIRST x-forwarded-for
 *     entry (Caddy strips inbound values and appends the connecting IP, so the
 *     first entry is the real client), then x-real-ip as a fallback.
 *   - 'false': there is no trusted proxy in front of the app. The forwarded
 *     headers are attacker-controllable, so ignore them entirely and fall back
 *     to a single constant bucket. This collapses every request to one key for
 *     rate limiting instead of handing each spoofed header its own per-IP
 *     bucket, which would let an attacker rotate the header to bypass the limit.
 *
 * Returns a string suitable for use as a rate-limit key component.
 */

const UNTRUSTED_FALLBACK = 'unknown';

function readForwardedHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  const firstHop = forwarded?.split(',')[0]?.trim();
  if (firstHop) return firstHop;

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return '127.0.0.1';
}

export function getClientIp(request: Request | NextRequest): string {
  // When no trusted proxy is asserted, the forwarded headers cannot be trusted.
  // Collapse to a single bucket so a spoofed header cannot mint new rate-limit
  // keys. Next.js does not expose the raw connection address in the route
  // handler runtime, so a constant is the safe floor here.
  if (process.env.TRUSTED_FORWARDED_FOR === 'false') {
    return UNTRUSTED_FALLBACK;
  }

  return readForwardedHeaders(request.headers);
}
