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
  // A query owned by a user must still fire the global (userId:null) channels:
  // those are the only channels the current UI can create. Without OR-ing in the
  // globals, enabling multi-user mode (which reassigns every query to a user id)
  // would match zero channels and silently kill all alerts, including the
  // admin's own. When per-user channels land, both a user's own and the globals
  // fire — the natural household behavior.
  const channels = await prisma.notificationChannel.findMany({
    where: {
      enabled: true,
      // SQL `IN (id, NULL)` never matches NULL rows, so OR the two explicitly.
      ...(ownerUserId === null
        ? { userId: null }
        : { OR: [{ userId: ownerUserId }, { userId: null }] }),
    },
    select: { id: true, type: true, config: true, userId: true },
  });

  return Promise.all(
    channels.map(async (ch): Promise<NotifyOutcome> => {
      const type = ch.type as ChannelType;
      try {
        // Thread the owner id through: a per-user channel (userId set) stays
        // untrusted, so its outbound host is SSRF-checked at send time.
        await sendToChannel({ id: ch.id, type, config: ch.config, userId: ch.userId }, message);
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
