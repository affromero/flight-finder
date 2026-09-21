import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { Prisma, TravelAdmission, TravelLease } from '@/generated/prisma/client';
import { TravelJobError } from './errors';
import { interruptTravelRun } from './interruption';

export interface TravelLeaseToken { id: string; owner: string; generation: number; topologyVersion: number }
const DEFAULT_LEASE_MS = 120_000;
const EPOCH = new Date(0);

/** Fixed transaction-scoped admission lock, before resource and domain locks.
 * 761932105 is reserved for admission; 761932104 protects schema setup.
 * Never hold this lock during browser, VPN or notification execution.
 */
export async function lockTravelAdmission(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(761932105)`;
}

async function admissionRow(tx: Prisma.TransactionClient): Promise<TravelAdmission> {
  await lockTravelAdmission(tx);
  return tx.travelAdmission.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} });
}

async function quarantine(tx: Prisma.TransactionClient, reason: string, cleanupRecoveryAllowed = false): Promise<TravelAdmission> {
  const current = await admissionRow(tx);
  if (current.quarantinedAt && (!current.cleanupRecoveryAllowed || cleanupRecoveryAllowed)) return current;
  await tx.travelLease.updateMany({ where: { OR: [{ state: 'held' }, { expiresAt: { gt: EPOCH } }] }, data: { state: 'quarantined' } });
  return tx.travelAdmission.update({ where: { id: current.id }, data: {
    quarantinedAt: new Date(), quarantineReason: reason.slice(0, 1000), cleanupRecoveryAllowed, recoveryGeneration: { increment: 1 },
  } });
}

async function checkAdmission(tx: Prisma.TransactionClient): Promise<TravelAdmission> {
  const current = await admissionRow(tx);
  if (current.quarantinedAt) return current;
  const expired = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "TravelLease" WHERE
      (state = 'held' AND "expiresAt" <= clock_timestamp()) OR state = 'quarantined' OR
      (state = 'idle' AND "expiresAt" > ${EPOCH}) LIMIT 1`;
  if (expired.length) {
    const legacyState = await tx.travelLease.count({ where: { OR: [{ state: 'idle', expiresAt: { gt: EPOCH } }, { state: 'quarantined' }] } });
    return quarantine(tx, 'A travel worker stopped without verified cleanup. Open /admin for recovery after stopping old workers and verifying the network.', legacyState === 0);
  }
  const legacy = await tx.hotelLease.findUnique({ where: { id: 'worker' } });
  if (legacy && legacy.expiresAt.getTime() > 0) return quarantine(tx, 'A previous hotel worker requires upgrade recovery. Stop old workers and verify the network before continuing.');
  return current;
}

function duration(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000 || milliseconds > 600_000) throw new TravelJobError('Invalid lease duration', 400);
}

async function localTopology(tx: Prisma.TransactionClient) {
  const config = await tx.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { vpnProvider: true } });
  const provider = config?.vpnProvider ?? 'none';
  if (!['none', 'expressvpn'].includes(provider)) throw new TravelJobError('Unsupported VPN configuration', 503);
  const vpnEnabled = provider === 'expressvpn';
  const proxy = process.env.EXPRESSVPN_SOCKS_URL || null;
  const endpoint = process.env.EXPRESSVPN_API_URL || 'http://expressvpn:8000';
  if (vpnEnabled) {
    try {
      if (!['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error('API protocol');
      if (proxy && !['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(proxy).protocol)) throw new Error('Proxy protocol');
    } catch { throw new TravelJobError('Invalid VPN endpoint configuration', 503); }
  }
  // Endpoint identities may contain credentials. Persist only their fingerprint.
  const topologyHash = createHash('sha256').update(JSON.stringify([provider, vpnEnabled ? endpoint : null, vpnEnabled ? proxy : null])).digest('hex');
  return { topologyHash, vpnEnabled, systemWide: vpnEnabled && proxy === null };
}

export async function acquireTravelLease(requested: string, milliseconds = DEFAULT_LEASE_MS): Promise<TravelLeaseToken | null> {
  if (!['vpn', 'browser'].includes(requested)) throw new TravelJobError('Unknown travel resource', 400);
  duration(milliseconds);
  const outcome = await prisma.$transaction(async tx => {
    let admission = await checkAdmission(tx);
    if (admission.quarantinedAt) return { error: admission.quarantineReason! };
    const topology = await localTopology(tx);
    if (admission.topologyHash !== topology.topologyHash) {
      const held = await tx.travelLease.count({ where: { state: { not: 'idle' } } });
      if (held) {
        admission = await quarantine(tx, 'Travel workers disagree about network configuration. Stop all workers and verify their configuration before recovery.');
        return { error: admission.quarantineReason! };
      }
      admission = await tx.travelAdmission.update({ where: { id: admission.id }, data: { ...topology, topologyVersion: { increment: 1 } } });
    }
    const id = topology.systemWide ? 'network' : requested;
    const owner = randomUUID();
    await tx.travelLease.upsert({ where: { id }, create: { id, owner, expiresAt: EPOCH }, update: {} });
    const rows = await tx.$queryRaw<TravelLease[]>`
      UPDATE "TravelLease" SET owner = ${owner}, generation = generation + 1, state = 'held',
        "topologyVersion" = ${admission.topologyVersion},
        "expiresAt" = clock_timestamp() + ${milliseconds} * interval '1 millisecond'
      WHERE id = ${id} AND state = 'idle' RETURNING *`;
    const row = rows[0];
    return { token: row ? { id, owner, generation: row.generation, topologyVersion: row.topologyVersion } : null };
  });
  if ('error' in outcome) throw new TravelJobError(outcome.error ?? 'Travel execution requires administrator recovery', 503);
  return outcome.token;
}

export async function renewTravelLease(lease: TravelLeaseToken, milliseconds = DEFAULT_LEASE_MS): Promise<boolean> {
  duration(milliseconds);
  return prisma.$transaction(async tx => {
    const admission = await checkAdmission(tx);
    if (admission.quarantinedAt || admission.topologyVersion !== lease.topologyVersion) return false;
    const held = await tx.travelLease.findFirst({ where: { id: lease.id, owner: lease.owner, generation: lease.generation, topologyVersion: lease.topologyVersion, state: 'held' } });
    if (!held) return false;
    let matches: boolean;
    try { matches = (await localTopology(tx)).topologyHash === admission.topologyHash; }
    catch { matches = false; }
    if (!matches) {
      await quarantine(tx, 'Network configuration changed during travel execution. Stop old workers and verify configuration before recovery.');
      return false;
    }
    const count = await tx.$executeRaw`
      UPDATE "TravelLease" SET "expiresAt" = clock_timestamp() + ${milliseconds} * interval '1 millisecond'
      WHERE id = ${lease.id} AND owner = ${lease.owner} AND generation = ${lease.generation}
        AND "topologyVersion" = ${lease.topologyVersion} AND state = 'held' AND "expiresAt" > clock_timestamp()`;
    return count === 1;
  });
}

/** Call only after all owned browser and network cleanup has completed. */
export async function releaseTravelLease(lease: TravelLeaseToken): Promise<void> {
  if (await acknowledgeTravelCleanup(lease)) return;
  await prisma.$transaction(async tx => {
    const admission = await checkAdmission(tx);
    if (admission.quarantinedAt || admission.topologyVersion !== lease.topologyVersion) return;
    await tx.travelLease.updateMany({ where: {
      id: lease.id, owner: lease.owner, generation: lease.generation, topologyVersion: lease.topologyVersion, state: 'held',
    }, data: { state: 'idle', expiresAt: EPOCH } });
  });
}

/** The original owner may acknowledge settled work and cleanup, never resume expired work.
 * No VPN state is inferred. Incidents from older runtimes remain administrator-only.
 */
export async function acknowledgeTravelCleanup(lease: TravelLeaseToken): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const admission = await checkAdmission(tx);
    if (admission.vpnEnabled || admission.topologyVersion !== lease.topologyVersion
      || (admission.quarantinedAt && !admission.cleanupRecoveryAllowed)) return false;
    if ((await localTopology(tx)).topologyHash !== admission.topologyHash) return false;
    const held = await tx.travelLease.findFirst({ where: {
      id: lease.id, owner: lease.owner, generation: lease.generation, topologyVersion: lease.topologyVersion,
      state: { in: ['held', 'quarantined'] },
    } });
    if (!held) return false;
    const legacy = await tx.hotelLease.findUnique({ where: { id: 'worker' } });
    if (legacy && legacy.expiresAt.getTime() > 0) return false;
    const jobs = await tx.travelJob.findMany({ where: {
      status: 'running', leaseResource: lease.id, leaseOwner: lease.owner, leaseGeneration: lease.generation,
    } });
    const message = 'Travel worker interrupted; previous verified observations were retained. Retry the search.';
    for (const job of jobs) {
      await interruptTravelRun(tx, job, message);
      await tx.travelJob.update({ where: { id: job.id }, data: {
        status: 'failed', error: message, completedAt: new Date(), activeKey: null,
        leaseResource: null, leaseOwner: null, leaseGeneration: null,
      } });
    }
    await tx.travelLease.update({ where: { id: lease.id }, data: { state: 'idle', expiresAt: EPOCH } });
    if (admission.quarantinedAt && await tx.travelLease.count({ where: { OR: [{ state: { not: 'idle' } }, { expiresAt: { gt: EPOCH } }] } }) === 0) {
      await tx.travelAdmission.update({ where: { id: admission.id }, data: {
        quarantinedAt: null, quarantineReason: null, cleanupRecoveryAllowed: false,
        recoveredAt: new Date(), recoveredBy: 'verified-worker-cleanup', recoveryGeneration: { increment: 1 },
      } });
    }
    return true;
  });
}

export async function lockTravelLease(tx: Prisma.TransactionClient, lease: TravelLeaseToken): Promise<void> {
  const admission = await admissionRow(tx);
  if (admission.quarantinedAt || admission.topologyVersion !== lease.topologyVersion) throw new TravelJobError('Travel execution requires administrator recovery', 503);
  if ((await localTopology(tx)).topologyHash !== admission.topologyHash) throw new TravelJobError('Travel network configuration changed', 503);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "TravelLease" WHERE id = ${lease.id} AND owner = ${lease.owner}
      AND generation = ${lease.generation} AND "topologyVersion" = ${lease.topologyVersion}
      AND state = 'held' AND "expiresAt" > clock_timestamp() FOR UPDATE`;
  if (!rows.length) throw new TravelJobError('Travel worker lease was lost');
}

export async function quarantineTravelLease(lease: TravelLeaseToken, reason: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await lockTravelAdmission(tx);
    const current = await tx.travelLease.findUnique({ where: { id: lease.id } });
    // A late report from a recovered generation cannot stop its replacement.
    if (!current || current.owner !== lease.owner || current.generation !== lease.generation || current.state === 'idle') return;
    await quarantine(tx, reason);
  });
}

export async function getTravelAdmission() {
  return prisma.$transaction(async tx => {
    const current = await checkAdmission(tx);
    const leases = await tx.travelLease.findMany({ select: { id: true, state: true, generation: true, expiresAt: true }, orderBy: { id: 'asc' } });
    return { quarantinedAt: current.quarantinedAt, reason: current.quarantineReason, recoveryGeneration: current.recoveryGeneration,
      topologyVersion: current.topologyVersion, systemWide: current.systemWide, vpnEnabled: current.vpnEnabled, leases };
  });
}

/** Surface global pauses only after the caller has authorized the requested search. */
export async function assertTravelAvailable(isAdmin: boolean): Promise<void> {
  if (!(await getTravelAdmission()).quarantinedAt) return;
  throw new TravelJobError(isAdmin
    ? 'Travel searches are paused after a worker interruption. Open /admin and review Travel worker recovery, then retry the search or its status.'
    : 'Travel searches are paused after a worker interruption. Ask your administrator to recover the worker, then retry the search or its status.', 503);
}

/** Recovery is an explicit operator assertion, not a status-read inference. */
export async function recoverTravelAdmission(actor: { userId: string | null; isAdmin: boolean }, raw: unknown): Promise<void> {
  if (!actor.isAdmin) throw new TravelJobError('Administrator access required', 403);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TravelJobError('Invalid recovery request', 400);
  const input = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0 || input.oldWorkersStopped !== true || input.networkVerified !== true
    || Object.keys(input).some(key => !['generation', 'oldWorkersStopped', 'networkVerified'].includes(key))) throw new TravelJobError('Confirm stopped workers and verified network before recovery', 400);
  await prisma.$transaction(async tx => {
    const admission = await checkAdmission(tx);
    if (!admission.quarantinedAt || admission.recoveryGeneration !== input.generation) throw new TravelJobError('Recovery state changed; reload before continuing', 412);
    const now = new Date(), message = 'Travel worker interrupted; previous verified observations were retained.';
    const jobs = await tx.travelJob.findMany({ where: { status: 'running' } });
    for (const job of jobs) {
      await interruptTravelRun(tx, job, message);
      await tx.travelJob.update({ where: { id: job.id }, data: { status: 'failed', error: message, completedAt: now, activeKey: null, leaseResource: null, leaseOwner: null, leaseGeneration: null } });
    }
    await tx.travelLease.updateMany({ data: { state: 'idle', expiresAt: EPOCH, generation: { increment: 1 } } });
    await tx.hotelLease.updateMany({ data: { owner: randomUUID(), expiresAt: EPOCH } });
    await tx.hotelSearchRun.updateMany({ where: { status: 'running', travelJob: null }, data: { status: 'failed', error: message, completedAt: now } });
    await tx.travelAdmission.update({ where: { id: admission.id }, data: {
      quarantinedAt: null, quarantineReason: null, cleanupRecoveryAllowed: false, recoveredAt: now, recoveredBy: actor.userId ?? 'instance-administrator', recoveryGeneration: { increment: 1 },
    } });
  });
}
