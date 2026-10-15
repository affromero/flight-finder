import { prisma } from '@/lib/prisma';
import { hasFlightExpired } from '@/lib/criteria/flight-expiry';
import type { Prisma, Query } from '@/generated/prisma/client';
import { ADMISSION_TX_OPTIONS, enqueueTravelJob, lockTravelAdmission, TravelJobError } from './jobs';
import { awaitTravelJob } from './coordinator';
import { travelTransaction } from './context';

export async function submitFlightJob(queryId: string | null, request: Prisma.InputJsonObject, fetchRunId?: string): Promise<unknown> {
  const job = await prisma.$transaction(async tx => {
    await lockTravelAdmission(tx);
    const query = queryId ? await tx.query.findUnique({ where: { id: queryId } }) : null;
    if (queryId && !query) throw new TravelJobError('Flight query not found', 404);
    const queued = await enqueueTravelJob(query ? { kind: 'flight_query', queryId: query.id, userId: query.userId } : { kind: 'flight_batch', userId: null }, tx);
    if (queued.request && JSON.stringify(queued.request) !== JSON.stringify(request)) throw new TravelJobError('Another flight check is already queued for this query');
    if (!queued.request) await tx.travelJob.update({ where: { id: queued.id }, data: { request } });
    if (fetchRunId) {
      const updated = await tx.fetchRun.updateMany({ where: { id: fetchRunId, queryId: queryId!, status: 'in_progress', OR: [{ travelJobId: null }, { travelJobId: queued.id }] }, data: { travelJobId: queued.id } });
      if (!updated.count) throw new TravelJobError('Flight refresh state changed');
    }
    return queued;
  }, ADMISSION_TX_OPTIONS);
  return awaitTravelJob(job.id);
}

/** Source ownership and criteria must still match the query that was observed. */
export async function flightTransaction<T>(query: Pick<Query, 'id' | 'userId' | 'updatedAt'>, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return travelTransaction(async (tx, job) => {
    await tx.$queryRaw`SELECT id FROM "Query" WHERE id = ${query.id} FOR UPDATE`;
    const current = await tx.query.findUnique({ where: { id: query.id } });
    if (!current || !current.active || hasFlightExpired(current) || current.userId !== query.userId || current.updatedAt.getTime() !== query.updatedAt.getTime()
      || (job.kind === 'flight_query' && (job.queryId !== query.id || job.userId !== current.userId))) throw new TravelJobError('Flight query changed during execution');
    return work(tx);
  });
}
