import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';
import { requireAdminApi } from '@/lib/admin-guard';
import { sendToChannel, type ChannelType, type ChannelMessage } from '@/lib/notifications/channels';
import { resolveBaseUrl } from '@/lib/notifications/run';

export const dynamic = 'force-dynamic';

const TEST_THROTTLE_SECONDS = 10;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireAdminApi();
  if (denial) return denial;
  const { id } = await params;

  const channel = await prisma.notificationChannel.findFirst({
    where: { id, userId: null },
    select: { id: true, type: true, config: true },
  });
  if (!channel) return apiError('Channel not found', 404);

  // Throttle test sends so the endpoint can't be used as an outbound relay.
  // Fail closed: if the limiter cannot confirm the reservation (Redis down or
  // erroring), deny the send rather than letting the relay guard silently lapse.
  if (redis) {
    try {
      const reserved = await redis.set(`notify:test:${id}`, '1', 'EX', TEST_THROTTLE_SECONDS, 'NX');
      if (reserved !== 'OK') {
        return apiError('Test send was triggered moments ago. Try again shortly.', 429);
      }
    } catch {
      return apiError('Rate limiter is unavailable. Try again shortly.', 503);
    }
  }

  const config = await prisma.extractionConfig.findFirst({
    where: { id: 'singleton' },
    select: { publicBaseUrl: true },
  });
  const baseUrl = resolveBaseUrl(config?.publicBaseUrl);
  const message: ChannelMessage = {
    title: 'Flight Finder test alert',
    body: 'This is a test notification from Flight Finder. If you can read this, the channel is working.',
    url: baseUrl ?? '',
    data: { test: true },
  };

  try {
    await sendToChannel(
      { id: channel.id, type: channel.type as ChannelType, config: channel.config, userId: null },
      message,
    );
    return apiSuccess({ sent: true });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'Test send failed', 502);
  }
}
