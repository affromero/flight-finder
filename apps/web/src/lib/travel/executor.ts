import { prisma } from '@/lib/prisma';
import type { TravelJob } from '@/generated/prisma/client';
import { acknowledgeTravelCleanup, acquireTravelLease, lockTravelLease, quarantineTravelLease, releaseTravelLease, renewTravelLease, type TravelLeaseToken } from './admission';
import { claimTravelJob, completeTravelJob, failTravelJob, travelResource } from './jobs';
import { TravelJobError } from './errors';
import { TravelCleanupError, TravelExecution, withTravelExecution } from './execution';
import { withTravelContext } from './context';
import { CarSearchCleanupError } from '../cars/search';
import { TravelVpnSession } from './vpn';
import type { VpnProviderType } from '../scraper/vpn';
import { interruptTravelRun } from './interruption';

const HEARTBEAT_MS = 1000;
const LEASE_MS = 120_000;

function unsafeCleanup(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false;
  seen.add(error);
  if (error instanceof TravelCleanupError || error instanceof CarSearchCleanupError) return true;
  if (error instanceof AggregateError && error.errors.some(cause => unsafeCleanup(cause, seen))) return true;
  return error instanceof Error && error.cause !== undefined && unsafeCleanup(error.cause, seen);
}

/** A lease is released only after work, heartbeat and owned cleanup have settled. */
export async function executeTravelJob(id: string, work: (job: TravelJob, lease: TravelLeaseToken) => Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const candidate = await prisma.travelJob.findUnique({ where: { id } });
  if (!candidate || candidate.status !== 'queued') return false;
  const lease = await acquireTravelLease(travelResource(candidate.kind));
  if (!lease) return false;
  const execution = new TravelExecution({ jobId: id, resource: lease.id, generation: lease.generation });
  const abort = () => execution.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: Promise<void> = Promise.resolve();
  let authorityLost = false;
  const tick = async () => {
    try {
      if (!(await renewTravelLease(lease, LEASE_MS))) throw new TravelJobError('Travel worker authority was lost');
      const current = await prisma.travelJob.findUnique({ where: { id }, select: { status: true } });
      if (!current || current.status === 'cancelled') execution.abort(new TravelJobError('Travel job was cancelled'));
    } catch (error) {
      authorityLost = true;
      execution.abort(error);
    } finally {
      if (!stopped && !authorityLost) timer = setTimeout(() => { heartbeat = tick(); }, HEARTBEAT_MS);
    }
  };
  let vpn: TravelVpnSession | undefined, failure: unknown;
  let handled = false;
  try {
    execution.check();
    const job = await claimTravelJob(id, lease);
    if (job) {
      const config = await prisma.$transaction(async tx => {
        await lockTravelLease(tx, lease);
        return tx.extractionConfig.findUnique({ where: { id: 'singleton' } });
      });
      timer = setTimeout(() => { heartbeat = tick(); }, HEARTBEAT_MS);
      execution.check();
      vpn = new TravelVpnSession(lease, (config?.vpnProvider ?? 'none') as VpnProviderType);
      await vpn.prepare();
      execution.check();
      const session = vpn;
      const outcome = await withTravelContext({ job, lease, config, vpn }, () => withTravelExecution(execution, () => work(job, lease)));
      await session.dispose();
      signal?.throwIfAborted();
      const current = await prisma.travelJob.findUnique({ where: { id } });
      if (current?.status === 'running') await completeTravelJob(id, lease, async tx => {
        if (outcome !== undefined) await tx.travelJob.update({ where: { id }, data: { result: JSON.parse(JSON.stringify(outcome)) } });
      });
      handled = true;
    }
  } catch (error) {
    failure = error;
    try {
      if (unsafeCleanup(error)) {
        await quarantineTravelLease(lease, 'Travel execution or cleanup lost its safety guarantees. Stop old workers and verify the network before recovery.');
      } else if (!authorityLost) {
        const current = await prisma.travelJob.findUnique({ where: { id }, select: { status: true } });
        if (current?.status === 'running') {
          const message = 'Travel check could not finish; previous observations were retained.';
          await failTravelJob(id, lease, message, (tx, job) => interruptTravelRun(tx, job, message));
        }
      }
    } catch (persistError) { failure = new AggregateError([error, persistError], 'Travel failure could not be recorded'); }
  } finally {
    signal?.removeEventListener('abort', abort);
    stopped = true;
    clearTimeout(timer);
    await heartbeat;
    try {
      await execution.dispose();
      if (vpn?.type === 'none') {
        await vpn.dispose();
        if (!(await acknowledgeTravelCleanup(lease))) await quarantineTravelLease(lease, 'Travel worker cleanup requires administrator recovery. Open /admin to review the incident.');
      } else if (authorityLost) await quarantineTravelLease(lease, 'Travel worker authority was lost before cleanup completed. Open /admin for administrator recovery.');
      else {
        await vpn?.dispose();
        await releaseTravelLease(lease);
      }
    } catch (cleanupError) {
      failure = new TravelCleanupError(failure === undefined ? [cleanupError] : [failure, cleanupError], 'Travel cleanup could not be verified');
      try { await quarantineTravelLease(lease, 'Travel cleanup could not be verified. Stop old workers and verify the network before recovery.'); }
      catch (persistError) { failure = new TravelCleanupError([failure, persistError], 'Travel cleanup and quarantine recording failed'); }
    }
  }
  if (failure !== undefined) throw failure;
  return handled;
}
