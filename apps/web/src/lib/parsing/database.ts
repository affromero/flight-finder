import type { Prisma } from '@/generated/prisma/client';
import { serializable } from '@/lib/sidedoor/access/transaction';

export function parseTransaction<T>(work: (database: Prisma.TransactionClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return serializable(work, { bounded: true, signal });
}
