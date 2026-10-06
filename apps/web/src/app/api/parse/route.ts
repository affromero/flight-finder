import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { parseFlightQuery } from '@/lib/scraper/parse-query';
import { redis } from '@/lib/redis';
import { getClientIp } from '@/lib/trusted-ip';
import { readParseInput, type ParseInput } from '@/lib/parsing/input';

const PARSE_RATE_LIMIT = 30;        // max requests
const PARSE_RATE_WINDOW_SECONDS = 60; // per 60 seconds

async function checkParseRateLimit(ip: string): Promise<{ limited: boolean; retryAfter: number }> {
  if (!redis) return { limited: false, retryAfter: 0 };
  const key = `parse-rate:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, PARSE_RATE_WINDOW_SECONDS);
    }
    if (count > PARSE_RATE_LIMIT) {
      const ttl = await redis.ttl(key);
      return { limited: true, retryAfter: ttl > 0 ? ttl : PARSE_RATE_WINDOW_SECONDS };
    }
  } catch {
    // Redis unavailable: fail-open so parsing still works during outages
  }
  return { limited: false, retryAfter: 0 };
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const { limited, retryAfter } = await checkParseRateLimit(ip);
  if (limited) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Too many requests; please slow down' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      },
    );
  }

  const body = await request.json().catch(() => null);
  let input: ParseInput;
  try { input = readParseInput(body); }
  catch (error) { return apiError(error instanceof Error ? error.message : 'Invalid parse request', 400); }
  if (body.mode !== undefined && body.mode !== 'sync' && body.mode !== 'async') return apiError('Invalid parse mode', 400);
  if (body.mode === 'async') {
    const [{ enqueueParse }, { privateParseEndpoint, requestParseActor }] = await Promise.all([
      import('@/lib/parsing/jobs'), import('@/lib/parsing/http'),
    ]);
    return privateParseEndpoint(async () => apiSuccess(await enqueueParse(input, await requestParseActor(request), ip), 202));
  }

  try {
    const { response } = await parseFlightQuery(input.query, input.conversationHistory, { signal: request.signal });

    return apiSuccess(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to parse query';
    return apiError(msg, 422);
  }
}
