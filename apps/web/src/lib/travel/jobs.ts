import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { Prisma, type TravelJob } from '@/generated/prisma/client';
import { TravelJobError } from './errors';
import { ADMISSION_TX_OPTIONS, lockTravelAdmission, lockTravelLease, type TravelLeaseToken } from './admission';
export { TravelJobError } from './errors';
export { acquireTravelLease, renewTravelLease, releaseTravelLease, ADMISSION_TX_OPTIONS, lockTravelAdmission, lockTravelLease, type TravelLeaseToken } from './admission';
export type TravelJobRequest =
  | { kind: 'flight_batch'; userId: null }
  | { kind: 'flight_preview'; userId: string | null }
  | { kind: 'flight_query'; queryId: string; userId: string | null }
  | { kind: 'hotel_search'; hotelRunId: string; userId: string | null }
  | { kind: 'car_search'; carRunId: string; userId: string | null };
const clearClaim = { leaseResource: null, leaseOwner: null, leaseGeneration: null, activeKey: null };

export function travelResource(kind: TravelJob['kind']): string {
  return kind === 'flight_batch' || kind === 'flight_query' ? 'vpn' : 'browser';
}
export async function lockTravelResource(tx: Prisma.TransactionClient, kind: TravelJob['kind']): Promise<void> {
  await lockTravelAdmission(tx);
  const resource = travelResource(kind);
  await tx.$executeRaw`INSERT INTO "TravelLease" (id, owner, "expiresAt") VALUES (${resource}, ${randomUUID()}, ${new Date(0)}) ON CONFLICT (id) DO NOTHING`;
  await tx.$queryRaw`SELECT id FROM "TravelLease" WHERE id = ${resource} FOR UPDATE`;
}
export async function enqueueTravelJob(request: TravelJobRequest, tx?: Prisma.TransactionClient): Promise<TravelJob> {
  if (!tx) return prisma.$transaction(transaction => enqueueTravelJob(request, transaction), ADMISSION_TX_OPTIONS);
  // Follow the same resource-first lock order as result commits. This also
  // serializes enqueue with a generation change without taking over the lease.
  await lockTravelResource(tx, request.kind);
  const id = randomUUID();
  let activeKey: string = request.kind;
  if (request.kind === 'flight_preview') activeKey += `:${id}`;
  let owner: { userId: string | null } | null = null;
  if (request.kind === 'flight_query') {
    activeKey += `:${request.queryId}`;
    owner = (await tx.$queryRaw<{ userId: string | null }[]>`SELECT "userId" FROM "Query" WHERE id = ${request.queryId} FOR UPDATE`)[0] ?? null;
  }
  if (request.kind === 'hotel_search') {
    activeKey += `:${request.hotelRunId}`;
    const source = await tx.hotelSearchRun.findUnique({ where: { id: request.hotelRunId }, select: { trackerId: true } });
    if (source?.trackerId) {
      const trackers = await tx.$queryRaw<{ userId: string | null }[]>`SELECT "userId" FROM "HotelTracker" WHERE id = ${source.trackerId} FOR UPDATE`;
      if (!trackers[0] || trackers[0].userId !== request.userId) throw new TravelJobError('Travel job owner does not match its tracker', 404);
    }
    owner = (await tx.$queryRaw<{ userId: string | null }[]>`SELECT "userId" FROM "HotelSearchRun" WHERE id = ${request.hotelRunId} FOR UPDATE`)[0] ?? null;
  }
  if (request.kind === 'car_search') {
    activeKey += `:${request.carRunId}`;
    const source = await tx.carSearchRun.findUnique({ where: { id: request.carRunId }, select: { trackerId: true } });
    if (source?.trackerId) {
      const trackers = await tx.$queryRaw<{ userId: string | null }[]>`SELECT "userId" FROM "CarTracker" WHERE id = ${source.trackerId} FOR UPDATE`;
      if (!trackers[0] || trackers[0].userId !== request.userId) throw new TravelJobError('Travel job owner does not match its tracker', 404);
    }
    owner = (await tx.$queryRaw<{ userId: string | null }[]>`SELECT "userId" FROM "CarSearchRun" WHERE id = ${request.carRunId} FOR UPDATE`)[0] ?? null;
  }
  if (request.kind !== 'flight_batch' && request.kind !== 'flight_preview' && (!owner || owner.userId !== request.userId)) throw new TravelJobError('Travel job owner does not match its source', 404);
  const conflict = request.kind === 'hotel_search'
    ? Prisma.sql`("hotelRunId") DO UPDATE SET "hotelRunId" = EXCLUDED."hotelRunId"`
    : request.kind === 'car_search'
      ? Prisma.sql`("carRunId") DO UPDATE SET "carRunId" = EXCLUDED."carRunId"`
      : Prisma.sql`("activeKey") DO UPDATE SET "activeKey" = EXCLUDED."activeKey"`;
  const jobs = await tx.$queryRaw<TravelJob[]>`
    INSERT INTO "TravelJob" (id, kind, "userId", "queryId", "hotelRunId", "carRunId", "activeKey")
    VALUES (${id}, ${request.kind}::"TravelJobKind", ${request.userId},
      ${request.kind === 'flight_query' ? request.queryId : null},
      ${request.kind === 'hotel_search' ? request.hotelRunId : null},
      ${request.kind === 'car_search' ? request.carRunId : null}, ${activeKey})
    ON CONFLICT ${conflict} RETURNING *`;
  const job = jobs[0];
  if (!job) throw new TravelJobError('Travel job could not be queued');
  if (job.userId !== request.userId) throw new TravelJobError('Previous owner still has an active job; cancel it before reassignment');
  return job;
}
export async function claimTravelJob(id: string, lease: TravelLeaseToken): Promise<TravelJob | null> {
  return prisma.$transaction(async tx => {
    await lockTravelLease(tx, lease);
    const rows = await tx.$queryRaw<TravelJob[]>`SELECT * FROM "TravelJob" WHERE id = ${id} AND status = 'queued' FOR UPDATE`;
    const job = rows[0];
    if (!job) return null;
    if (lease.id !== 'network' && travelResource(job.kind) !== lease.id) throw new TravelJobError('Worker does not hold the required resource');
    return tx.travelJob.update({ where: { id }, data: { status: 'running', attempts: { increment: 1 }, claimedAt: new Date(), leaseResource: lease.id, leaseOwner: lease.owner, leaseGeneration: lease.generation } });
  }, ADMISSION_TX_OPTIONS);
}
/** Acquire before domain row locks and keep this transaction open through writes. */
export async function guardTravelJob(tx: Prisma.TransactionClient, id: string, lease: TravelLeaseToken): Promise<TravelJob> {
  await lockTravelLease(tx, lease);
  const rows = await tx.$queryRaw<TravelJob[]>`
    SELECT * FROM "TravelJob" WHERE id = ${id} AND status = 'running'
      AND "leaseResource" = ${lease.id} AND "leaseOwner" = ${lease.owner} AND "leaseGeneration" = ${lease.generation} FOR UPDATE`;
  if (!rows[0]) throw new TravelJobError('Travel job was cancelled, completed or reclaimed');
  return rows[0];
}
export async function completeTravelJob<T>(id: string, lease: TravelLeaseToken, persist: (tx: Prisma.TransactionClient, job: TravelJob) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    const job = await guardTravelJob(tx, id, lease);
    const result = await persist(tx, job);
    await lockTravelLease(tx, lease);
    await tx.travelJob.update({ where: { id }, data: { ...clearClaim, status: 'succeeded', completedAt: new Date() } });
    return result;
  }, ADMISSION_TX_OPTIONS);
}
export async function failTravelJob(id: string, lease: TravelLeaseToken, error: unknown, persist?: (tx: Prisma.TransactionClient, job: TravelJob) => Promise<void>): Promise<void> {
  await prisma.$transaction(async tx => {
    const job = await guardTravelJob(tx, id, lease);
    await persist?.(tx, job);
    await lockTravelLease(tx, lease);
    await tx.travelJob.update({ where: { id }, data: { ...clearClaim, status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0,4000), completedAt: new Date() } });
  }, ADMISSION_TX_OPTIONS);
}
export async function cancelTravelJob(id: string, userId: string | null, isAdmin: boolean, tx?: Prisma.TransactionClient): Promise<boolean> {
  if (!tx) return prisma.$transaction(transaction => cancelTravelJob(id, userId, isAdmin, transaction), ADMISSION_TX_OPTIONS);
  await lockTravelAdmission(tx);
  const changed = await tx.travelJob.updateMany({
    where: { id, status: { in: ['queued', 'running'] }, ...(isAdmin ? {} : { userId }) },
    data: { ...clearClaim, status: 'cancelled', cancelledAt: new Date(), completedAt: new Date() },
  });
  return changed.count === 1;
}
