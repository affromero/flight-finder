import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { getCurrentUser } from '@/lib/user-auth';
import { isAggregatorSource } from '@/lib/scraper/navigate';
import { isPresetSlug } from '@/lib/avatars';
import { isThemeId } from '@/lib/theme';

async function requireUser() {
  if (!(await isMultiUserEnabled())) return { ok: false as const, status: 404 };
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, status: 401 };
  return { ok: true as const, user };
}

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return apiError('Unauthorized', auth.status);

  const { user } = auth;
  return apiSuccess({
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    theme: user.theme,
    defaultCurrency: user.defaultCurrency,
    defaultCountry: user.defaultCountry,
    preferredAirlines: user.preferredAirlines,
    preferredAggregators: user.preferredAggregators,
    cabinClass: user.cabinClass,
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return apiError('Unauthorized', auth.status);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const data: Record<string, unknown> = {};

  if (typeof body.displayName === 'string') {
    data.displayName = body.displayName.trim() || null;
  } else if (body.displayName === null) {
    data.displayName = null;
  }

  if (body.avatar === null) {
    data.avatar = null;
  } else if (typeof body.avatar === 'string') {
    if (!isPresetSlug(body.avatar)) {
      return apiError('avatar must be a known preset slug or null', 400);
    }
    data.avatar = body.avatar;
  }

  if (body.theme === null) {
    data.theme = null;
  } else if (typeof body.theme === 'string') {
    if (!isThemeId(body.theme)) {
      return apiError('theme must be a valid theme id or null', 400);
    }
    data.theme = body.theme;
  }

  if (body.defaultCurrency === null) {
    data.defaultCurrency = null;
  } else if (typeof body.defaultCurrency === 'string') {
    if (!/^[A-Z]{3}$/.test(body.defaultCurrency)) {
      return apiError('defaultCurrency must be a 3-letter ISO 4217 code or null', 400);
    }
    data.defaultCurrency = body.defaultCurrency;
  }

  if (body.defaultCountry === null) {
    data.defaultCountry = null;
  } else if (typeof body.defaultCountry === 'string') {
    if (!/^[A-Z]{2}$/.test(body.defaultCountry)) {
      return apiError('defaultCountry must be a 2-letter ISO 3166-1 code or null', 400);
    }
    data.defaultCountry = body.defaultCountry;
  }

  if (Array.isArray(body.preferredAirlines)) {
    for (const a of body.preferredAirlines) {
      if (typeof a !== 'string') {
        return apiError('preferredAirlines must be an array of strings', 400);
      }
    }
    data.preferredAirlines = body.preferredAirlines;
  }

  if (Array.isArray(body.preferredAggregators)) {
    for (const a of body.preferredAggregators) {
      if (!isAggregatorSource(a)) {
        return apiError(`preferredAggregators contains invalid value: ${JSON.stringify(a)}`, 422);
      }
    }
    data.preferredAggregators = body.preferredAggregators;
  }

  if (body.cabinClass === null) {
    data.cabinClass = null;
  } else if (typeof body.cabinClass === 'string') {
    const allowed = ['economy', 'premium_economy', 'business', 'first'];
    if (!allowed.includes(body.cabinClass)) {
      return apiError(`cabinClass must be one of: ${allowed.join(', ')}`, 400);
    }
    data.cabinClass = body.cabinClass;
  }

  if (Object.keys(data).length === 0) {
    return apiError('No supported fields to update', 400);
  }

  const updated = await prisma.user.update({
    where: { id: auth.user.id },
    data,
    select: {
      username: true,
      displayName: true,
      avatar: true,
      theme: true,
      defaultCurrency: true,
      defaultCountry: true,
      preferredAirlines: true,
      preferredAggregators: true,
      cabinClass: true,
    },
  });

  return apiSuccess(updated);
}
