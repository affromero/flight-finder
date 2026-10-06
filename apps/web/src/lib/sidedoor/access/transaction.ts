import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { retrySerializableTransaction } from 'thesidedoor-core/storage/sql';

export async function serializable<Result>(operation: (database: Prisma.TransactionClient) => Promise<Result>, options?: { bounded: boolean; signal?: AbortSignal }): Promise<Result> {
  return retrySerializableTransaction(() => prisma.$transaction(async database => {
    options?.signal?.throwIfAborted();
    if (options?.bounded) {
      await database.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
      await database.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
    }
    const result = await operation(database);
    options?.signal?.throwIfAborted();
    return result;
  }, { isolationLevel: 'Serializable', ...(options?.bounded ? { maxWait: 1000, timeout: 3000 } : {}) }), { signal: options?.signal });
}
