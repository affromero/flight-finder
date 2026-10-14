import { prisma } from '@/lib/prisma';
import { ADMISSION_TX_OPTIONS, cancelTravelJob, enqueueTravelJob, lockTravelAdmission } from './jobs';
import { executeTravelJob } from './executor';
import { checkTravelAuthority, currentTravelContext } from './context';
import { currentTravelExecution } from './execution';
import { TravelJobError } from './errors';

const QUEUE_WAIT_MS = 60_000;
const ORPHAN_AGE_MS = 5 * 60_000;

/** Only abandoned queued callbacks can expire; running work requires recovery. */
export async function expireQueuedPreviews(): Promise<void> {
  await prisma.$transaction(async tx => {
    await lockTravelAdmission(tx);
    await tx.travelJob.updateMany({
      where: { kind: 'flight_preview', status: 'queued', createdAt: { lt: new Date(Date.now() - ORPHAN_AGE_MS) } },
      data: { status: 'failed', activeKey: null, completedAt: new Date(), error: 'Preview process stopped before execution; search again' },
    });
  }, ADMISSION_TX_OPTIONS);
}

/** Arguments and results stay in memory; the database stores only job state. */
export async function withPreviewTravelAdmission<T>(work: () => Promise<T>, options: { userId?: string | null; signal?: AbortSignal } = {}): Promise<T> {
  options.signal?.throwIfAborted();
  if (currentTravelContext()) {
    currentTravelExecution()?.check();
    await checkTravelAuthority();
    return work();
  }
  const job = await enqueueTravelJob({ kind: 'flight_preview', userId: options.userId ?? null });
  const deadline = Date.now() + QUEUE_WAIT_MS;
  const run = async (): Promise<T> => {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      let result: T | undefined;
      const handled = await executeTravelJob(job.id, async () => {
        result = await work();
      }, options.signal);
      if (handled) return result as T;
      const current = await prisma.travelJob.findUnique({ where: { id: job.id }, select: { status: true } });
      if (current?.status !== 'queued') throw new TravelJobError('Preview was interrupted; search again', 503);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new TravelJobError('Travel workers are busy; try the preview again shortly', 503);
  };
  let outcome: { ok: true; result: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, result: await run() }; }
  catch (error) { outcome = { ok: false, error }; }
  try { await cancelTravelJob(job.id, job.userId, false); }
  catch (cancelError) {
    if (!outcome.ok) throw new AggregateError([outcome.error, cancelError], 'Preview failure and cancellation persistence failed', { cause: cancelError });
    throw cancelError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}
