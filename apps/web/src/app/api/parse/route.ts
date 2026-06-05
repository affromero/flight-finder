import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { parseFlightQuery } from '@/lib/scraper/parse-query';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { getClientIp } from '@/lib/trusted-ip';

const PARSE_RATE_LIMIT = 30;        // max requests
const PARSE_RATE_WINDOW_SECONDS = 60; // per 60 seconds
const PARSE_HISTORY_MAX_ENTRIES = 12; // defensive server-side cap on history array length

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
  if (!body?.query || typeof body.query !== 'string') {
    return apiError('Missing or invalid "query" field', 400);
  }

  const rawInput = body.query.trim();
  if (rawInput.length < 5 || rawInput.length > 500) {
    return apiError('Query must be between 5 and 500 characters', 400);
  }

  // Validate and sanitize conversationHistory defensively before passing to
  // the parser. Each entry must have string role and content; cap the array
  // length so callers cannot bypass the per-entry truncation done in
  // parse-query.ts via sheer volume.
  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined;
  if (Array.isArray(body.conversationHistory)) {
    const raw = (body.conversationHistory as unknown[]).slice(0, PARSE_HISTORY_MAX_ENTRIES);
    const valid = raw.filter(
      (entry): entry is { role: string; content: string } =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).role === 'string' &&
        typeof (entry as Record<string, unknown>).content === 'string',
    );
    conversationHistory = valid.map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: entry.content,
    }));
  }

  try {
    const { response, usage } = await parseFlightQuery(rawInput, conversationHistory);

    // Log API usage for the parse call
    const config = await prisma.extractionConfig.findFirst({ where: { id: 'singleton' } });
    await prisma.apiUsageLog.create({
      data: {
        provider: config?.provider ?? 'anthropic',
        model: config?.model ?? 'claude-haiku-4-5-20251001',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: 0,
        operation: 'parse-query',
        durationMs: 0,
      },
    });

    return apiSuccess(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to parse query';
    return apiError(msg, 422);
  }
}
