import type { Prisma } from '@/generated/prisma/client';
import { authorizeMutation } from '@/lib/query-auth';
import { notificationTransaction } from '../database';
import { lockNotificationQuery, notificationPolicy } from './authority';

export class NotificationPolicyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface PolicyEdit { mode: 'inherit' | 'selected'; channelIds: string[]; revision: number }

export function parseNotificationPolicy(raw: unknown): PolicyEdit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new NotificationPolicyError('Invalid notification settings', 400);
  const body = raw as Record<string, unknown>;
  if ((body.mode !== 'inherit' && body.mode !== 'selected') || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0
    || !Array.isArray(body.channelIds) || body.channelIds.length > 100
    || body.channelIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)
    || Object.keys(body).some(key => !['mode', 'channelIds', 'revision', 'deleteToken'].includes(key))) throw new NotificationPolicyError('Invalid notification settings', 400);
  const channelIds = [...new Set((body.channelIds as string[]).map(id => id.trim()))].sort();
  if (body.mode === 'inherit' && channelIds.length) throw new NotificationPolicyError('Inherited settings cannot select channels', 400);
  return { mode: body.mode, channelIds, revision: Number(body.revision) };
}

async function availableChannels(tx: Prisma.TransactionClient, owner: string | null) {
  return tx.notificationChannel.findMany({ where: { OR: [{ userId: owner }, { userId: null }] },
    select: { id: true, type: true, label: true, enabled: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

export async function readNotificationSettings(queryId: string, token: string | null) {
  return notificationTransaction(async tx => {
    const query = await lockNotificationQuery(tx, queryId);
    if (!query) throw new NotificationPolicyError('Tracker not found', 404);
    const auth = await authorizeMutation(query, token);
    if (!auth.ok) throw new NotificationPolicyError(auth.error ?? 'Forbidden', auth.status ?? 403);
    return { ...await notificationPolicy(tx, queryId), channels: await availableChannels(tx, query.userId) };
  });
}

export async function updateNotificationSettings(queryId: string, token: string | null, raw: unknown) {
  const edit = parseNotificationPolicy(raw);
  return notificationTransaction(async tx => {
    const query = await lockNotificationQuery(tx, queryId);
    if (!query) throw new NotificationPolicyError('Tracker not found', 404);
    const auth = await authorizeMutation(query, token);
    if (!auth.ok) throw new NotificationPolicyError(auth.error ?? 'Forbidden', auth.status ?? 403);
    const current = await notificationPolicy(tx, queryId);
    if (edit.revision !== current.revision) throw new NotificationPolicyError('Notification settings changed. Reload before saving.', 409);
    const channels = await availableChannels(tx, query.userId);
    if (edit.channelIds.some(id => !channels.some(channel => channel.id === id))) throw new NotificationPolicyError('One or more channels are unavailable', 400);
    if (current.mode === edit.mode && JSON.stringify([...current.channelIds].sort()) === JSON.stringify(edit.channelIds)) return { ...current, channels };
    if (current.revision >= 2_147_483_647) throw new NotificationPolicyError('Notification settings revision exhausted', 409);
    const data = { mode: edit.mode, channelIds: edit.channelIds, revision: current.revision + 1 };
    await tx.queryNotificationPolicy.upsert({ where: { queryId }, create: { queryId, ...data }, update: data });
    return { ...data, channels };
  });
}
