import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { verifyPassword, createSessionToken, setSessionCookie } from '@/lib/admin-auth';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getClientIp } from '@/lib/trusted-ip';
import {
  incrementAuthFailure,
  getAuthFailureCount,
  getRetryAfterSeconds,
  clearAuthFailures,
} from '@/lib/rate-limit';

const MAX_FAILURES = 5;

export async function POST(request: NextRequest) {
  if (await isMultiUserEnabled()) {
    return apiError('Use /api/auth/login', 410);
  }

  const body = await request.json().catch(() => null);
  if (!body?.password) {
    return apiError('Missing password', 400);
  }

  const ip = getClientIp(request);
  const rateKey = `${ip}:admin`;

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

  if (!(await verifyPassword(body.password))) {
    await incrementAuthFailure(rateKey);
    return apiError('Invalid password', 401);
  }

  await clearAuthFailures(rateKey);
  const token = createSessionToken();
  await setSessionCookie(token);

  return apiSuccess({ ok: true });
}
