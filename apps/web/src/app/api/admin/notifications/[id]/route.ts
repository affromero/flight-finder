import { NextRequest } from 'next/server';
import type { Prisma } from '@/generated/prisma/client';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { requireAdminApi } from '@/lib/admin-guard';
import { mergeStoredConfig, type ChannelType } from '@/lib/notifications/channels';
import { redactChannel, assertChannelUrls } from '@/lib/notifications/admin';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const { id } = await params;

  // Scope to global channels so this admin surface never edits a user's
  // personal channel.
  const existing = await prisma.notificationChannel.findFirst({
    where: { id, userId: null },
    select: { id: true, type: true, config: true },
  });
  if (!existing) return apiError('Channel not found', 404);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400);

  const data: Record<string, unknown> = {};
  if (typeof body.label === 'string') data.label = body.label.trim() || null;
  else if (body.label === null) data.label = null;
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled;

  if (body.config !== undefined) {
    const type = existing.type as ChannelType;
    try {
      assertChannelUrls(type, body.config);
      data.config = mergeStoredConfig(type, existing.config, body.config) as unknown as Prisma.InputJsonValue;
    } catch (err) {
      return apiError(err instanceof Error ? err.message : 'Invalid channel config', 400);
    }
  }

  const channel = await prisma.notificationChannel.update({
    where: { id },
    data,
    select: { id: true, type: true, label: true, config: true, enabled: true, createdAt: true },
  });
  return apiSuccess({ channel: redactChannel(channel) });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const { id } = await params;

  const existing = await prisma.notificationChannel.findFirst({
    where: { id, userId: null },
    select: { id: true },
  });
  if (!existing) return apiError('Channel not found', 404);

  await prisma.notificationChannel.delete({ where: { id } });
  return apiSuccess({ deleted: true });
}
