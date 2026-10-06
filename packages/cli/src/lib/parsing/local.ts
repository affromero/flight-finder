import { setTimeout } from 'node:timers/promises';
import { prisma } from '@/lib/prisma';
import { AccessService, HouseholdProfileService } from 'thesidedoor-core/access';
import { FlightFinderAccessStore } from '../../../../../apps/web/src/lib/sidedoor/access/access-store.js';
import { enqueueParse, readParseJob } from '../../../../../apps/web/src/lib/parsing/jobs.js';
import { executeNextParse } from '../../../../../apps/web/src/lib/parsing/executor.js';
import { ParseClientError } from '../../../../../apps/web/src/lib/parsing/client.js';
import type { ParseInput } from '../../../../../apps/web/src/lib/parsing/input.js';
import type { ParseJobStatus } from '../../../../../apps/web/src/lib/parsing/types.js';
import { parseTransaction } from '../../../../../apps/web/src/lib/parsing/database.js';

async function localActor() {
  const store = new FlightFinderAccessStore();
  const state = await store.read();
  const session = process.env.FLIGHT_FINDER_SESSION;
  const access = new AccessService({ store });
  const principal = session ? access.sessionFromState(state, session).principal : undefined;
  const selected = session && state.mode === 'household' ? new HouseholdProfileService(access).selectedFromState(state, session) : null;
  const owners = state.principals.filter(entry => entry.role === 'owner');
  const id = session ? selected?.id ?? principal?.id : owners.length === 1 ? owners[0]!.id : undefined;
  if (!id || !await prisma.user.findUnique({ where: { id }, select: { id: true } }))
    throw new Error('Local background parsing requires an initialized owner or an authenticated profile');
  return { ownerId: id };
}

/** Execute only this command's job. Other workers may claim it first. */
export async function parseLocally(input: ParseInput, signal: AbortSignal, onJob: (job: ParseJobStatus | null) => void) {
  signal.throwIfAborted();
  const actor = await localActor();
  signal.throwIfAborted();
  let job = await enqueueParse(input, actor, 'local-cli');
  let execution: Promise<void> | undefined;
  let executionError: unknown;
  let terminal = false;
  const deadline = Date.now() + 22 * 60 * 1000;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (executionError) throw executionError;
      job = await readParseJob(job.id, actor);
      signal.throwIfAborted();
      onJob(job);
      signal.throwIfAborted();
      if (job.status === 'completed' && job.result) { terminal = true; return job.result; }
      if (job.status === 'failed' || job.status === 'cancelled') { terminal = true; throw new ParseClientError(job.error ?? job.status); }
      if (Date.now() >= deadline) throw new ParseClientError('timeout');
      if (job.status === 'queued' && !execution) {
        execution = executeNextParse(signal, job.id).then(() => { execution = undefined; }, error => { executionError = error; execution = undefined; });
      }
      await setTimeout(250, undefined, { signal });
    }
  } finally {
    onJob(null);
    await settleLocal(job.id, actor, execution, terminal);
  }
}

async function settleLocal(id: string, actor: { ownerId: string }, execution: Promise<void> | undefined, terminal: boolean): Promise<void> {
  let uncertain = false;
  try { if (!terminal) await readParseJob(id, actor, true); }
  catch { uncertain = true; }
  await execution;
  if (uncertain) throw new ParseClientError('cancellation_unconfirmed');
  const until = Date.now() + 5000;
  for (;;) {
    let reservation;
    try { reservation = await parseTransaction(tx => tx.parseReservation.findUnique({ where: { jobId: id }, select: { settledAt: true, quarantinedAt: true } })); }
    catch { throw new ParseClientError('cancellation_unconfirmed'); }
    if (!reservation || reservation.settledAt) return;
    if (reservation.quarantinedAt || Date.now() >= until) throw new ParseClientError('cancellation_unconfirmed');
    await setTimeout(100);
  }
}
