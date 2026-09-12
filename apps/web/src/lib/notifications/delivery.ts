import type { Prisma, TravelAlertDelivery } from '@/generated/prisma/client';
import { dispatchNotifications } from './notify';
import type { ChannelMessage } from './channels/types';

export const DELIVERY_RETRY_MS = 300_000;
export const DELIVERY_CLAIM_MS = 120_000;
export interface ClaimedDelivery extends TravelAlertDelivery {
  owner: string | null;
  payload: ChannelMessage;
}
export type DeliveryGuard = <T>(work: (tx: Prisma.TransactionClient, row: TravelAlertDelivery) => Promise<T>) => Promise<T>;

/** One receipt per accepted channel, with authority checked before every send.
 * Acceptance followed by a lost receipt can repeat. Events carry a stable ID.
 */
export async function deliverClaimedAlert(entry: ClaimedDelivery, guarded: DeliveryGuard, parent?: AbortSignal,
  onUpdated?: (tx: Prisma.TransactionClient, row: TravelAlertDelivery) => Promise<void>): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Notification batch deadline exceeded')), 60_000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const update = async (tx: Prisma.TransactionClient, data: Prisma.TravelAlertDeliveryUpdateInput) => {
    const row = await tx.travelAlertDelivery.update({ where: { id: entry.id }, data });
    await onUpdated?.(tx, row);
  };
  try {
    const outcomes = await dispatchNotifications(entry.owner, { ...entry.payload, data: { ...entry.payload.data, eventId: entry.eventKey } }, entry.deliveredIds, {
      signal,
      beforeSend: () => guarded(async () => { signal.throwIfAborted(); }),
      onDelivered: id => guarded(async (tx, row) => {
        await update(tx, { deliveredIds: [...new Set([...row.deliveredIds, id])] });
      }),
    });
    await guarded(async (tx, row) => {
      const failed = outcomes.filter(outcome => !outcome.ok);
      const pending = failed.length > 0 || row.deliveredIds.length === 0;
      await update(tx, { pending, claimToken: null, claimExpiresAt: null, nextAttemptAt: new Date(Date.now() + DELIVERY_RETRY_MS),
        lastError: failed.length ? failed.map(outcome => outcome.error).join('; ').slice(0, 1000) : pending ? 'No enabled notification channel is available; delivery will retry.' : null });
    });
  } catch (error) {
    await guarded(async tx => {
      await update(tx, { claimToken: null, claimExpiresAt: null, nextAttemptAt: new Date(Date.now() + DELIVERY_RETRY_MS), lastError: 'Notification delivery was interrupted; acknowledged channels will not be resent.' });
    }).catch(() => undefined); // Revoked claims cannot overwrite a replacement.
    throw error;
  } finally { clearTimeout(timer); }
}
