import { prisma } from '@/lib/prisma';
import type { ChannelMessage, ChannelType } from './channels/types';
import { sendToChannel } from './channels';
import { notificationTransaction } from './database';
import type { Prisma } from '@/generated/prisma/client';

export interface NotifyOutcome {
  channelId: string;
  type: ChannelType;
  ok: boolean;
  error?: string;
}

export interface NotificationDeliveryControl {
  signal: AbortSignal;
  beforeSend: (channelId: string) => Promise<void>;
  onDelivered: (channelId: string) => Promise<void>;
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
  deliveredChannelIds: string[] = [],
  control?: NotificationDeliveryControl,
): Promise<NotifyOutcome[]> {
  // A query owned by a user must still fire the global (userId:null) channels:
  // those are the only channels the current UI can create. Without OR-ing in the
  // globals, enabling multi-user mode (which reassigns every query to a user id)
  // would match zero channels and silently kill all alerts, including the
  // admin's own. When per-user channels land, both a user's own and the globals
  // fire — the natural household behavior.
  const read = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) => control ? notificationTransaction(query, control.signal) : query(prisma);
  const channels = await read(tx => tx.notificationChannel.findMany({
    where: {
      enabled: true,
      ...(deliveredChannelIds.length ? { id: { notIn: deliveredChannelIds } } : {}),
      // SQL `IN (id, NULL)` never matches NULL rows, so OR the two explicitly.
      ...(ownerUserId === null
        ? { userId: null }
        : { OR: [{ userId: ownerUserId }, { userId: null }] }),
    },
    select: { id: true, type: true, config: true, userId: true },
    ...(control ? { orderBy: { id: 'asc' as const } } : {}),
  }));

  const send = async (ch: (typeof channels)[number]): Promise<NotifyOutcome> => {
    const type = ch.type as ChannelType;
    try {
      // Thread the owner id through: a per-user channel (userId set) stays
      // untrusted, so its outbound host is SSRF-checked at send time.
      await sendToChannel({ id: ch.id, type, config: ch.config, userId: ch.userId }, message, { signal: control?.signal });
      return { channelId: ch.id, type, ok: true };
    } catch (err) {
      return {
        channelId: ch.id,
        type,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  if (!control) return Promise.all(channels.map(send));
  const outcomes: NotifyOutcome[] = [];
  for (const entry of channels) {
    control.signal.throwIfAborted();
    // A channel can be disabled, removed or reassigned after batch enumeration.
    const channel = await read(tx => tx.notificationChannel.findUnique({ where: { id: entry.id } }));
    if (!channel?.enabled || (channel.userId !== null && channel.userId !== ownerUserId)) continue;
    await control.beforeSend(entry.id);
    control.signal.throwIfAborted();
    const outcome = await send(channel);
    // Persistence/authority failures stop the batch, not just this channel.
    if (outcome.ok) await control.onDelivered(channel.id);
    outcomes.push(outcome);
  }
  return outcomes;
}
