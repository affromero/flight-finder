import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { trackPageViewAsync } from '@/lib/analytics/track';
import { classifyBot } from '@/lib/analytics/bots';
import { apiSuccess, apiError } from '@/lib/api-response';

// This endpoint records hosted-instance page views. The Edge middleware calls it
// fire-and-forget because it cannot import the Node-only analytics writer itself.
// It is gated to internal callers via a shared secret (the app's
// ADMIN_SESSION_SECRET) so it cannot be written directly from the public
// internet. Without that gate the route would allow analytics flooding (WAL/disk
// fill), IP spoofing, and bot-score laundering. The middleware is the only
// legitimate caller and it sees the real client headers, so its values are
// trusted here; string lengths are still bounded to keep DB rows sane.
const MAX_PATH = 2048;
const MAX_USER_AGENT = 512;
const MAX_REFERRER = 2048;
const MAX_IP = 64;

function cap(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function isInternalCall(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return false;
  const provided = request.headers.get('x-internal-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!isInternalCall(request)) {
    return apiError('Forbidden', 403);
  }

  try {
    const body = await request.json();
    const path = cap(body?.path, MAX_PATH);
    const userAgent = cap(body?.userAgent, MAX_USER_AGENT);
    const referrer = cap(body?.referrer, MAX_REFERRER) || undefined;

    if (!path || !userAgent) {
      return apiError('Missing required fields', 400);
    }

    // The middleware computed these from the original client request, so they
    // are trusted. Bound the IP length and clamp the score defensively.
    const ip = cap(body?.ip, MAX_IP) || 'unknown';
    const botScore = computeBotScore(userAgent, body?.botScore);

    trackPageViewAsync({ path, ip, userAgent, referrer, botScore });
    return apiSuccess({ tracked: true });
  } catch {
    return apiError('Invalid request body', 400);
  }
}

// A known bot UA always wins (score 3). Otherwise the middleware's header-derived
// hint is clamped to the valid [1, 3] range.
function computeBotScore(userAgent: string, hint: unknown): number {
  if (classifyBot(userAgent).isBot) return 3;

  if (typeof hint === 'number' && Number.isFinite(hint)) {
    return Math.min(3, Math.max(1, Math.trunc(hint)));
  }
  return 1;
}
