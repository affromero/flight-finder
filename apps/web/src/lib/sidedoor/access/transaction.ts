import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { retrySerializableTransaction } from 'thesidedoor-core/storage/sql';

export async function serializable<Result>(operation: (database: Prisma.TransactionClient) => Promise<Result>): Promise<Result> {
  return retrySerializableTransaction(() => prisma.$transaction(operation, { isolationLevel: 'Serializable' }));
}
