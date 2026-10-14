import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { travelDelay } from './execution';

/** Heartbeat budgets are measured against fake timers; database calls are stubbed. */
const harness = vi.hoisted(() => ({
  renew: vi.fn<() => Promise<boolean>>(),
  statusRead: vi.fn<() => Promise<{ status: string } | null>>(),
  reads: 0,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    travelJob: {
      findUnique: vi.fn(async (args: { select?: unknown }) => {
        if (args?.select) return harness.statusRead();
        // First unsighted read is the queued candidate; later ones re-check a running job.
        return harness.reads++ === 0 ? { id: 'job1', kind: 'flight_batch', status: 'queued' } : { id: 'job1', kind: 'flight_batch', status: 'running' };
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
      extractionConfig: { findUnique: async () => ({ vpnProvider: 'none' }) },
    })),
  },
}));

vi.mock('./admission', () => ({
  ADMISSION_TX_OPTIONS: { maxWait: 10_000, timeout: 30_000 },
  acquireTravelLease: vi.fn(async () => ({ id: 'vpn', owner: 'owner', generation: 1, topologyVersion: 1 })),
  renewTravelLease: vi.fn(() => harness.renew()),
  releaseTravelLease: vi.fn(async () => undefined),
  acknowledgeTravelCleanup: vi.fn(async () => true),
  quarantineTravelLease: vi.fn(async () => undefined),
  lockTravelLease: vi.fn(async () => undefined),
}));

vi.mock('./jobs', () => ({
  travelResource: () => 'vpn',
  guardTravelJob: vi.fn(async () => ({ id: 'job1', kind: 'flight_batch' })),
  claimTravelJob: vi.fn(async () => ({ id: 'job1', kind: 'flight_batch' })),
  completeTravelJob: vi.fn(async () => undefined),
  failTravelJob: vi.fn(async () => undefined),
}));

vi.mock('./interruption', () => ({ interruptTravelRun: vi.fn(async () => undefined) }));
vi.mock('../scraper/vpn', () => ({
  createVpnProvider: () => ({ getStatus: async () => ({ connected: false }), listLocations: async () => [], isSystemWide: () => false }),
}));

const { executeTravelJob } = await import('./executor');

function longWork(): Promise<string> { return travelDelay(600_000).then(() => 'must not be reached'); }

describe('travel worker heartbeat under database failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.renew.mockReset();
    harness.statusRead.mockReset();
    harness.reads = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('aborts only after renewal failures exhaust the lease lifetime', async () => {
    harness.renew.mockRejectedValue(new Error('simulated expired transaction'));
    harness.statusRead.mockResolvedValue({ status: 'running' });
    let settled = false;
    const run = executeTravelJob('job1', longWork);
    const rejected = expect(run).rejects.toThrow('simulated expired transaction');
    run.finally(() => { settled = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
  });

  it('aborts when cancellation stays unreadable even while renewals succeed', async () => {
    harness.renew.mockResolvedValue(true);
    harness.statusRead.mockRejectedValue(new Error('status read unavailable'));
    let settled = false;
    const run = executeTravelJob('job1', longWork);
    const rejected = expect(run).rejects.toThrow('status read unavailable');
    run.finally(() => { settled = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
  });

  it('completes work after a transient renewal error recovers', async () => {
    let failures = 0;
    harness.renew.mockImplementation(async () => {
      if (failures++ < 2) throw new Error('simulated expired transaction');
      return true;
    });
    harness.statusRead.mockResolvedValue({ status: 'running' });
    const run = executeTravelJob('job1', async () => { await travelDelay(20_000); return 'recovered'; });
    const resolved = expect(run).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await resolved;
  });

  it('still aborts immediately on a definitive renewal refusal', async () => {
    harness.renew.mockResolvedValue(false);
    harness.statusRead.mockResolvedValue({ status: 'running' });
    const run = executeTravelJob('job1', longWork);
    const rejected = expect(run).rejects.toThrow('Travel worker authority was lost');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
  });
});
