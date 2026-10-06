import { Prisma } from '@/generated/prisma/client';
import { parseTransaction } from './database';
import { notificationTransaction } from '../notifications/database';
import { parseFlightQuery } from '../scraper/parse-query';
import { captureParseConfiguration } from './configuration';
import { claimParseJob, lockParseQueue } from './jobs';
import { readParseInput } from './input';
import { PARSE_LEASE_MS } from './types';

type Claim = NonNullable<Awaited<ReturnType<typeof claimParseJob>>>;
class ParseExecutionError extends Error {
  constructor(readonly code: string) { super(code); }
}

function uncertainCleanup(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<Error>();
  for (let depth = 0; depth < 32 && pending.length; depth++) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if ('code' in current && current.code === 'cleanup_failed') return true;
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

async function verifyClaim(database: Prisma.TransactionClient, claim: Claim) {
  const now = new Date();
  const [job, reservation, captured] = await Promise.all([
    database.parseJob.findUnique({ where: { id: claim.job.id } }),
    database.parseReservation.findUnique({ where: { id: claim.reservation.id } }),
    captureParseConfiguration(database),
  ]);
  if (!job || job.status === 'cancelled') throw new ParseExecutionError('cancelled');
  if (job.status !== 'running' || job.claimOwner !== claim.job.claimOwner || job.generation !== claim.job.generation
    || !job.leaseUntil || job.leaseUntil <= now || job.expiresAt <= now
    || !reservation || reservation.settledAt || reservation.quarantinedAt || reservation.leaseUntil <= now)
    throw new ParseExecutionError('worker_interrupted');
  if (reservation.deadline <= now) throw new ParseExecutionError('timeout');
  if (captured.fingerprint !== job.configFingerprint) throw new ParseExecutionError('configuration_changed');
  return { job, reservation, captured, now };
}

async function heartbeat(claim: Claim): Promise<void> {
  await parseTransaction(async database => {
    await lockParseQueue(database);
    const { now } = await verifyClaim(database, claim);
    const leaseUntil = new Date(now.getTime() + PARSE_LEASE_MS);
    await database.parseJob.update({ where: { id: claim.job.id }, data: { leaseUntil } });
    await database.parseReservation.update({ where: { id: claim.reservation.id }, data: { leaseUntil } });
  });
}

/** Claim once, execute through the canonical parser, and fence the private result. */
export async function executeNextParse(signal?: AbortSignal, jobId?: string): Promise<boolean> {
  signal?.throwIfAborted();
  const claim = await claimParseJob(jobId);
  if (!claim) return false;
  const controller = new AbortController();
  const abortShutdown = () => controller.abort(new ParseExecutionError('worker_shutdown'));
  signal?.addEventListener('abort', abortShutdown, { once: true });
  if (signal?.aborted) abortShutdown();
  const timeout = setTimeout(() => controller.abort(new ParseExecutionError('timeout')), Math.max(1, claim.reservation.deadline.getTime() - Date.now()));
  timeout.unref();
  let checking = false;
  const monitor = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void heartbeat(claim).catch(error => controller.abort(error instanceof ParseExecutionError ? error : new ParseExecutionError('authority_unavailable'))).finally(() => { checking = false; });
  }, 2000);
  monitor.unref();
  let uncertain = false;
  try {
    const captured = await parseTransaction(async database => {
      await lockParseQueue(database);
      return (await verifyClaim(database, claim)).captured;
    }, controller.signal);
    controller.signal.throwIfAborted();
    const input = readParseInput(claim.job.input);
    const { response } = await parseFlightQuery(input.query, input.conversationHistory, {
      configuration: captured.configuration, promptDate: claim.job.promptDate, signal: controller.signal,
      persistUsage: data => notificationTransaction(database => database.apiUsageLog.create({ data }))
        .catch(() => { throw new ParseExecutionError('usage_unavailable'); }),
    });
    controller.signal.throwIfAborted();
    await parseTransaction(async database => {
      await lockParseQueue(database);
      await verifyClaim(database, claim);
      controller.signal.throwIfAborted();
      await database.parseJob.update({ where: { id: claim.job.id }, data: { status: 'completed', result: response as unknown as Prisma.InputJsonValue, error: null } });
    }, controller.signal);
  } catch (error) {
    uncertain = uncertainCleanup(error);
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
    const code = reason instanceof ParseExecutionError ? reason.code : 'provider_failed';
    await parseTransaction(async database => {
      await lockParseQueue(database);
      await database.parseJob.updateMany({ where: { id: claim.job.id, status: 'running', claimOwner: claim.job.claimOwner, generation: claim.job.generation }, data: { status: 'failed', error: code, result: Prisma.DbNull } });
    });
  } finally {
    clearInterval(monitor);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortShutdown);
    await parseTransaction(async database => {
      await lockParseQueue(database);
      await database.parseReservation.updateMany({ where: { id: claim.reservation.id, generation: claim.reservation.generation, settledAt: null }, data: uncertain ? { quarantinedAt: new Date() } : { settledAt: new Date() } });
    });
  }
  return true;
}
