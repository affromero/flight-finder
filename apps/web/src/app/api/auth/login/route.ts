import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { verifyHashedPassword } from '@/lib/password';
import { setSessionCookie } from '@/lib/admin-auth';
import { createUserSessionToken } from '@/lib/user-auth';
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
  if (!(await isMultiUserEnabled())) {
    return apiError('Not found', 404);
  }

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  // Password is optional: passwordless members (passwordHash null) tap to sign in.
  if (!username) {
    return apiError('Missing username', 400);
  }

  const ip = getClientIp(request);
  const rateKey = `${ip}:${username}`;

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

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    await incrementAuthFailure(rateKey);
    return apiError('Invalid username or password', 401);
  }

  // Passwordless members (passwordHash null) sign in directly; everyone with a
  // password must present a valid one.
  if (user.passwordHash !== null) {
    const ok = await verifyHashedPassword(password, user.passwordHash);
    if (!ok) {
      await incrementAuthFailure(rateKey);
      return apiError('Invalid username or password', 401);
    }
  }

  await clearAuthFailures(rateKey);
  const token = createUserSessionToken(user.id);
  await setSessionCookie(token);

  return apiSuccess({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
    },
  });
}
