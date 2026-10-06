import { createHash } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { lockTravelAdmission } from '@/lib/travel/admission';

export interface NotificationRouting {
  revision: number;
  mode: 'inherit' | 'selected';
  channels: { id: string; version: string | null }[];
}

export function channelAuthority(channel: { type: string; userId: string | null; config: unknown }): string {
  return createHash('sha256').update(JSON.stringify([channel.type, channel.userId, channel.config])).digest('hex');
}

/** Use the same lock order for settings, detection and delivery authority. */
export async function lockNotificationQuery(tx: Prisma.TransactionClient, id: string) {
  await lockTravelAdmission(tx);
  await tx.$queryRaw`SELECT id FROM "Query" WHERE id = ${id} FOR UPDATE`;
  return tx.query.findUnique({ where: { id } });
}

export async function notificationPolicy(tx: Prisma.TransactionClient, queryId: string) {
  const row = await tx.queryNotificationPolicy.findUnique({ where: { queryId } });
  if (!row) return { mode: 'inherit' as const, channelIds: [] as string[], revision: 0 };
  if (row.mode !== 'inherit' && row.mode !== 'selected') throw new Error('Invalid notification policy');
  return { mode: row.mode, channelIds: row.channelIds, revision: row.revision };
}

export async function captureNotificationRouting(tx: Prisma.TransactionClient, queryId: string, owner: string | null): Promise<NotificationRouting> {
  const policy = await notificationPolicy(tx, queryId);
  if (policy.mode === 'inherit') return { revision: policy.revision, mode: 'inherit', channels: [] };
  const channels = await tx.notificationChannel.findMany({ where: { id: { in: policy.channelIds }, OR: [{ userId: owner }, { userId: null }] }, orderBy: { id: 'asc' } });
  // A removed recipient revokes delivery, without discarding its price observation.
  return { revision: policy.revision, mode: 'selected', channels: policy.channelIds.map(id => {
    const channel = channels.find(candidate => candidate.id === id);
    return { id, version: channel ? channelAuthority(channel) : null };
  }) };
}

/** Only absent metadata is a legacy event. Present invalid metadata is revoked. */
export function decodeNotificationRouting(value: unknown): NotificationRouting {
  if (value === undefined) return { revision: 0, mode: 'inherit', channels: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification routing');
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || (row.mode !== 'inherit' && row.mode !== 'selected')
    || !Array.isArray(row.channels) || row.channels.length > 100) throw new Error('Invalid notification routing');
  const channels = row.channels.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification recipient');
    const channel = value as Record<string, unknown>;
    if (typeof channel.id !== 'string' || !channel.id || channel.id.length > 200
      || (channel.version !== null && (typeof channel.version !== 'string' || !/^[a-f0-9]{64}$/.test(channel.version)))) {
      throw new Error('Invalid notification recipient');
    }
    return { id: channel.id, version: channel.version };
  });
  if (new Set(channels.map(channel => channel.id)).size !== channels.length || (row.mode === 'inherit' && channels.length)) throw new Error('Invalid notification routing');
  return { revision: Number(row.revision), mode: row.mode, channels };
}

export async function assertNotificationRouting(tx: Prisma.TransactionClient, queryId: string, owner: string | null, routing: NotificationRouting): Promise<void> {
  const policy = await notificationPolicy(tx, queryId);
  if (policy.revision !== routing.revision || policy.mode !== routing.mode) throw new Error('Notification subscriptions changed');
  if (routing.mode === 'inherit') return;
  if (JSON.stringify([...policy.channelIds].sort()) !== JSON.stringify(routing.channels.map(channel => channel.id).sort())) throw new Error('Notification subscriptions changed');
  const channels = await tx.notificationChannel.findMany({ where: { id: { in: routing.channels.map(channel => channel.id) }, OR: [{ userId: owner }, { userId: null }] } });
  if (channels.length !== routing.channels.length || channels.some(channel => routing.channels.find(recipient => recipient.id === channel.id)?.version !== channelAuthority(channel))) {
    throw new Error('Notification recipient authority changed');
  }
}
