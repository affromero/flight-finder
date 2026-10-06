import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, TravelAlertDelivery } from '@/generated/prisma/client';
import { deliverClaimedAlert, type ClaimedDelivery, type DeliveryGuard } from '../delivery';
import { notificationTransaction } from '../database';

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: database.transaction } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('the final notification transport guard', () => {
  it('does not send a stale channel descriptor when its configuration changes during lookup', async () => {
    const original = { id: 'channel', type: 'webhook', enabled: true, userId: null, config: { url: 'http://127.0.0.1/original' } };
    const changed = { ...original, config: { url: 'http://127.0.0.1/replacement' } };
    let current = original;
    const message = { title: 'Fare dropped', body: 'The fare is 100 USD', url: 'https://example.com/q/tracker', data: { currentMin: 100 } };
    let row: TravelAlertDelivery = { id: 'event', eventKey: 'flight:stable-event', queryId: 'tracker', carTrackerId: null, hotelAlertId: null,
      message, pending: true, deliveredIds: [], claimToken: 'claim', claimExpiresAt: new Date(Date.now() + 60_000),
      nextAttemptAt: new Date(), lastError: null, createdAt: new Date() };
    const tx = {
      $executeRaw: async () => 0,
      notificationChannel: {
        findMany: async () => [original],
        findUnique: async () => {
          const snapshot = current;
          current = changed; // The lookup returns its old snapshot after an external edit commits.
          return snapshot;
        },
      },
      travelAlertDelivery: { update: async ({ data }: { data: Partial<TravelAlertDelivery> }) => { row = { ...row, ...data }; return row; } },
    } as unknown as Prisma.TransactionClient;
    database.transaction.mockImplementation(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx));
    const guarded: DeliveryGuard = work => notificationTransaction(tx => work(tx, row));
    const transport = vi.fn(async () => new Response('Accepted', { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const entry: ClaimedDelivery = { ...row, owner: null, payload: message };

    await expect(deliverClaimedAlert(entry, guarded)).rejects.toThrow(/changed before transport/);

    expect(transport).not.toHaveBeenCalled();
    expect(row).toMatchObject({ pending: true, deliveredIds: [], claimToken: null });
  });
});
