import { OptimisticStateStore } from 'thesidedoor-core/storage/optimistic';
import { sqlStateBackend } from 'thesidedoor-core/storage/sql';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';

export function sharedStateStore<State>(id: string, parse: (value: unknown) => State, initial: () => State, database: Pick<Prisma.TransactionClient, '$queryRawUnsafe'> = prisma) {
  return new OptimisticStateStore({
    backend: sqlStateBackend({
      query: (sql, values) => database.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values),
    }, 'postgres', id),
    parse,
    initial,
  });
}
