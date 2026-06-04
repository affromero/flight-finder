import { prisma } from '@/lib/prisma';
import type { ChannelMessage, ChannelType } from './channels/types';
import { sendToChannel } from './channels';

export interface NotifyOutcome {
  channelId: string;
  type: ChannelType;
  ok: boolean;
  error?: string;
}

/**
 * Send a message to every enabled channel owned by `ownerUserId` (null = the
 * global/admin-owned channels used in single-user self-hosting).
 *
 * Per-channel failures are isolated and reported, never thrown, so one broken
 * channel never suppresses the others or breaks the caller (a cron run).
 */
export async function dispatchNotifications(
  ownerUserId: string | null,
  message: ChannelMessage,
): Promise<NotifyOutcome[]> {
  const channels = await prisma.notificationChannel.findMany({
    where: { userId: ownerUserId, enabled: true },
    select: { id: true, type: true, config: true },
  });

  return Promise.all(
    channels.map(async (ch): Promise<NotifyOutcome> => {
      const type = ch.type as ChannelType;
      try {
        await sendToChannel({ id: ch.id, type, config: ch.config }, message);
        return { channelId: ch.id, type, ok: true };
      } catch (err) {
        return {
          channelId: ch.id,
          type,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
