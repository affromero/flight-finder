import { NextRequest } from 'next/server';
import type { Prisma } from '@/generated/prisma/client';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';
import { isChannelType, prepareStoredConfig } from '@/lib/notifications/channels';
import { redactChannel, assertChannelUrls } from '@/lib/notifications/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const channels = await prisma.notificationChannel.findMany({
    where: { userId: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, label: true, config: true, enabled: true, createdAt: true },
  });
  return apiSuccess({ channels: channels.map(redactChannel) });
}

export async function POST(request: NextRequest) {
  const denial = await requireAdminApi();
  if (denial) return denial;

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const type = body.type;
  if (!isChannelType(type)) return apiError('Unknown channel type', 400);

  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  let stored: Record<string, unknown>;
  try {
    assertChannelUrls(type, body.config);
    stored = prepareStoredConfig(type, body.config);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'Invalid channel config', 400);
  }

  const channel = await prisma.notificationChannel.create({
    data: { userId: null, type, label, enabled, config: stored as unknown as Prisma.InputJsonValue },
    select: { id: true, type: true, label: true, config: true, enabled: true, createdAt: true },
  });
  return apiSuccess({ channel: redactChannel(channel) }, 201);
}
