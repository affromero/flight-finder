import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type ParseJob } from '@/generated/prisma/client';
import { parseTransaction } from './database';
import { captureParseConfiguration, parseDigest } from './configuration';
import { effectiveParseHistory, type ParseInput } from './input';
import { PARSE_JOB_TTL_MS, PARSE_LEASE_MS, PARSE_MAX_QUEUED, PARSE_MAX_RUNNING, PARSE_QUEUE_MS, ParseJobError, type ParseJobStatus } from './types';
import type { ParseResponse } from '../scraper/parse-query';

export interface ParseActor { ownerId: string | null; capability?: string }

export function parseCapability(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ParseJobError('Invalid parse capability', 400);
  return value;
}

export async function lockParseQueue(database: Prisma.TransactionClient): Promise<void> {
  await database.$queryRaw`SELECT pg_advisory_xact_lock(748310263)::text`;
}

function permitted(job: ParseJob, actor: ParseActor): boolean {
  if (job.ownerId !== null) return actor.ownerId === job.ownerId;
  if (!actor.capability || !job.capabilityHash) return false;
  const actual = Buffer.from(parseDigest(actor.capability), 'hex');
  const expected = Buffer.from(job.capabilityHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseStatus(job: ParseJob, capability?: string): ParseJobStatus {
  return {
    id: job.id, status: job.status as ParseJobStatus['status'], expiresAt: job.expiresAt.toISOString(),
    ...(job.status === 'completed' && job.result ? { result: job.result as unknown as ParseResponse } : {}),
    ...(job.error ? { error: job.error } : {}), ...(capability ? { capability } : {}),
  };
}

async function maintainParseQueue(database: Prisma.TransactionClient, now: Date): Promise<void> {
  const interrupted = await database.parseReservation.findMany({ where: { settledAt: null, quarantinedAt: null, leaseUntil: { lte: now } } });
  for (const reservation of interrupted) {
    await database.parseJob.updateMany({ where: { id: reservation.jobId, generation: reservation.generation, status: 'running' }, data: { status: 'failed', error: 'worker_interrupted', result: Prisma.DbNull } });
    await database.parseReservation.updateMany({ where: { id: reservation.id, settledAt: null, generation: reservation.generation }, data: { quarantinedAt: now } });
  }
  await database.parseJob.updateMany({ where: { status: 'running', leaseUntil: { lte: now } }, data: { status: 'failed', error: 'worker_interrupted', result: Prisma.DbNull } });
  await database.parseJob.updateMany({ where: { status: 'queued', queueUntil: { lte: now } }, data: { status: 'failed', error: 'queue_timeout' } });
  await database.parseJob.deleteMany({ where: { expiresAt: { lte: now } } });
  await database.parseReservation.deleteMany({ where: { settledAt: { lte: new Date(now.getTime() - PARSE_JOB_TTL_MS) } } });
}

export async function enqueueParse(input: ParseInput, actor: ParseActor, ip: string): Promise<ParseJobStatus> {
  const capability = actor.ownerId ? undefined : actor.capability ?? randomBytes(32).toString('hex');
  const capabilityHash = capability ? parseDigest(capability) : null;
  const actorScope = actor.ownerId ? `user:${actor.ownerId}` : `cap:${capabilityHash}`;
  const ipHash = parseDigest(['parse-ip', ip]);
  const normalized = { query: input.query, conversationHistory: effectiveParseHistory(input.conversationHistory) };
  return parseTransaction(async database => {
    await lockParseQueue(database);
    const now = new Date();
    await maintainParseQueue(database, now);
    const { configuration, fingerprint } = await captureParseConfiguration(database);
    const promptDate = now.toISOString().slice(0, 10);
    const dedupKey = parseDigest({ normalized, fingerprint, promptDate });
    const existing = await database.parseJob.findFirst({ where: { actorScope, dedupKey, status: { in: ['queued', 'running', 'completed'] }, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
    if (existing) return parseStatus(existing, capability);
    const reservations = { settledAt: null };
    const [queued, actorQueued, ipQueued, actorRunning, ipRunning, recent] = await Promise.all([
      database.parseJob.count({ where: { status: 'queued' } }),
      database.parseJob.count({ where: { status: 'queued', actorScope } }),
      database.parseJob.count({ where: { status: 'queued', ipHash } }),
      database.parseReservation.count({ where: { ...reservations, actorScope } }),
      database.parseReservation.count({ where: { ...reservations, ipHash } }),
      database.parseJob.count({ where: { ipHash, createdAt: { gt: new Date(now.getTime() - 60_000) } } }),
    ]);
    if (queued >= PARSE_MAX_QUEUED || actorQueued + actorRunning >= 4 || ipQueued + ipRunning >= 8 || recent >= 30)
      throw new ParseJobError('Async parsing capacity reached; retry later', 429);
    const job = await database.parseJob.create({ data: {
      ownerId: actor.ownerId, capabilityHash, actorScope, ipHash, dedupKey, input: normalized,
      provider: configuration.provider, configFingerprint: fingerprint, promptDate,
      expiresAt: new Date(now.getTime() + PARSE_JOB_TTL_MS), queueUntil: new Date(now.getTime() + PARSE_QUEUE_MS),
    } });
    return parseStatus(job, capability);
  });
}

export async function readParseJob(id: string, actor: ParseActor, cancel = false): Promise<ParseJobStatus> {
  return parseTransaction(async database => {
    await lockParseQueue(database);
    const now = new Date();
    await maintainParseQueue(database, now);
    let job = await database.parseJob.findUnique({ where: { id } });
    if (!job || job.expiresAt <= now || !permitted(job, actor)) throw new ParseJobError('Parse job not found', 404);
    if (cancel && ['queued', 'running'].includes(job.status)) {
      job = await database.parseJob.update({ where: { id }, data: { status: 'cancelled', error: 'cancelled', result: Prisma.DbNull } });
    }
    return parseStatus(job);
  });
}

export async function claimParseJob() {
  return parseTransaction(async database => {
    await lockParseQueue(database);
    const now = new Date();
    await maintainParseQueue(database, now);
    const reservations = await database.parseReservation.findMany({ where: { settledAt: null } });
    if (reservations.length >= PARSE_MAX_RUNNING) return null;
    const candidates = await database.parseJob.findMany({ where: { status: 'queued', queueUntil: { gt: now } }, orderBy: { createdAt: 'asc' }, take: PARSE_MAX_QUEUED });
    const next = candidates.find(job => !reservations.some(reservation => reservation.provider === job.provider));
    if (!next) return null;
    const claimOwner = randomUUID();
    const generation = next.generation + 1;
    const leaseUntil = new Date(now.getTime() + PARSE_LEASE_MS);
    // The worker's overall bound also covers credential resolution and usage writes.
    const deadline = new Date(now.getTime() + 630_000);
    const job = await database.parseJob.update({ where: { id: next.id }, data: { status: 'running', claimOwner, generation, leaseUntil } });
    const reservation = await database.parseReservation.create({ data: { id: randomUUID(), jobId: job.id, actorScope: job.actorScope, ipHash: job.ipHash, provider: job.provider, claimOwner, generation, leaseUntil, deadline } });
    return { job, reservation };
  });
}

export async function parseRecoveryStatus() {
  return parseTransaction(async database => {
    await lockParseQueue(database);
    await maintainParseQueue(database, new Date());
    return database.parseReservation.findMany({ where: { settledAt: null, quarantinedAt: { not: null } }, select: { id: true, generation: true, provider: true, quarantinedAt: true } });
  });
}

export async function recoverParseReservation(id: string, generation: number, administrator: string): Promise<void> {
  await parseTransaction(async database => {
    await lockParseQueue(database);
    const now = new Date();
    await maintainParseQueue(database, now);
    const reservation = await database.parseReservation.findUnique({ where: { id } });
    if (!reservation || reservation.generation !== generation || reservation.settledAt || !reservation.quarantinedAt || reservation.leaseUntil > now)
      throw new ParseJobError('Recovery state changed; reload before continuing', 412);
    await database.parseReservation.update({ where: { id }, data: { settledAt: now, recoveredBy: administrator } });
  });
}
