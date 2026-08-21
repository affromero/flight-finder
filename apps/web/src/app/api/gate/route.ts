import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import {
  GATE_COOKIE,
  createSessionToken,
  gateCookieOptions,
  gateEnabled,
  verifyAccessPassword,
} from '@/lib/access/gate';
import { getClientIp } from '@/lib/trusted-ip';
import {
  incrementAuthFailure,
  getAuthFailureCount,
  getRetryAfterSeconds,
  clearAuthFailures,
} from '@/lib/rate-limit';

// The shared password is the only thing between the internet and a private
// instance, so unlock attempts get the same brute-force ceiling as admin login.
const MAX_FAILURES = 5;

export async function POST(request: NextRequest) {
  if (!gateEnabled()) return apiError('Not gated', 404);

  const body = await request.json().catch(() => null);
  if (!body?.password) return apiError('Missing password', 400);

  const ip = getClientIp(request);
  const rateKey = `${ip}:gate`;

  const failures = await getAuthFailureCount(rateKey);
  if (failures >= MAX_FAILURES) {
    const retryAfter = await getRetryAfterSeconds(rateKey);
    return new Response(
      JSON.stringify({ ok: false, error: 'Too many failed attempts; try again later' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter || 60),
        },
      },
    );
  }

  if (!(await verifyAccessPassword(body.password))) {
    await incrementAuthFailure(rateKey);
    return apiError('Invalid password', 401);
  }

  await clearAuthFailures(rateKey);
  const token = await createSessionToken();
  if (!token) return apiError('Gate misconfigured', 500);

  const response = apiSuccess({ ok: true });
  response.cookies.set(GATE_COOKIE, token, gateCookieOptions());
  return response;
}
