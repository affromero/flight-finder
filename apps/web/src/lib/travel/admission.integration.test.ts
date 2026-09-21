import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { acknowledgeTravelCleanup, acquireTravelLease, getTravelAdmission, quarantineTravelLease, recoverTravelAdmission, releaseTravelLease, renewTravelLease } from './admission';
import { claimTravelJob, completeTravelJob, enqueueTravelJob } from './jobs';

describe.skipIf(process.env.TRAVEL_INTEGRATION_TESTS !== '1')('persistent travel admission against isolated PostgreSQL', () => {
  let originalProvider: string | null | undefined;
  const admin = { userId: null, isAdmin: true };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Admission tests require disposable localhost:55440/car_test');
    originalProvider = (await prisma.extractionConfig.findUnique({ where: { id: 'singleton' } }))?.vpnProvider;
  });
  beforeEach(async () => {
    await prisma.travelJob.deleteMany();
    await prisma.travelLease.deleteMany();
    await prisma.travelAdmission.deleteMany();
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', vpnProvider: 'none' }, update: { vpnProvider: 'none' } });
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://vpn.test:8000');
    vi.stubEnv('EXPRESSVPN_SOCKS_URL', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await prisma.travelJob.deleteMany();
    await prisma.travelLease.deleteMany();
    await prisma.travelAdmission.deleteMany();
  });
  afterAll(async () => {
    if (originalProvider === undefined) await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    else await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: originalProvider } });
    await prisma.$disconnect();
  });
  async function acquire(resource = 'browser') {
    const lease = await acquireTravelLease(resource);
    if (!lease) throw new Error('Expected isolated resource availability');
    return lease;
  }
  async function recover() {
    const incident = await getTravelAdmission();
    await recoverTravelAdmission(admin, { generation: incident.recoveryGeneration, oldWorkersStopped: true, networkVerified: true });
  }
  it('blocks abandoned work until its original owner acknowledges cleanup', async () => {
    const old = await acquire();
    await prisma.travelLease.update({ where: { id: old.id }, data: { expiresAt: new Date(0) } });
    await expect(acquireTravelLease('vpn')).rejects.toMatchObject({ status: 503 });
    expect(await getTravelAdmission()).toMatchObject({ quarantinedAt: expect.any(Date), leases: [expect.objectContaining({ state: 'quarantined' })] });
    expect(await renewTravelLease(old)).toBe(false);
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
    await releaseTravelLease(old);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
    expect(await acquireTravelLease('browser')).not.toBeNull();
  });
  it('accepts clean owner release after expiry before another worker discovers it', async () => {
    const lease = await acquire();
    await prisma.travelLease.update({ where: { id: lease.id }, data: { expiresAt: new Date(0) } });
    await releaseTravelLease(lease);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
    expect(await acquireTravelLease('browser')).not.toBeNull();
  });
  it('waits for every affected owner to finish cleanup before admitting new work', async () => {
    const browser = await acquire(), vpn = await acquire('vpn');
    await prisma.travelLease.update({ where: { id: browser.id }, data: { expiresAt: new Date(0) } });
    await getTravelAdmission();
    expect(await acknowledgeTravelCleanup(browser)).toBe(true);
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
    expect(await acknowledgeTravelCleanup(vpn)).toBe(true);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it('retains manual recovery when cleanup fails during an expiry incident', async () => {
    const lease = await acquire();
    await prisma.travelLease.update({ where: { id: lease.id }, data: { expiresAt: new Date(0) } });
    const incident = await getTravelAdmission();
    await quarantineTravelLease(lease, 'Browser cleanup failed');
    expect(await acknowledgeTravelCleanup(lease)).toBe(false);
    expect(await getTravelAdmission()).toMatchObject({ quarantinedAt: expect.any(Date), reason: 'Browser cleanup failed', recoveryGeneration: incident.recoveryGeneration + 1 });
  });
  it('never automatically reopens incidents persisted by an older runtime', async () => {
    const lease = await acquire();
    await prisma.travelAdmission.update({ where: { id: 'singleton' }, data: { quarantinedAt: new Date(), quarantineReason: 'Older incident' } });
    expect(await acknowledgeTravelCleanup(lease)).toBe(false);
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
  });
  it('rejects an old direct worker cleanup acknowledgement without changing its replacement job', async () => {
    const old = await acquire('vpn');
    await quarantineTravelLease(old, 'Worker stopped');
    await recover();
    const replacement = await acquire('vpn');
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    await claimTravelJob(job.id, replacement);
    expect(await acknowledgeTravelCleanup(old)).toBe(false);
    await releaseTravelLease(old);
    await quarantineTravelLease(old, 'Late failure');
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'running', leaseOwner: replacement.owner });
    expect(await renewTravelLease(replacement)).toBe(true);
    expect(await acquireTravelLease('vpn')).toBeNull();
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it('does not let clean browser acknowledgement clear an expired VPN lease', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    const lease = await acquire();
    await prisma.travelLease.update({ where: { id: lease.id }, data: { expiresAt: new Date(0) } });
    expect(await acknowledgeTravelCleanup(lease)).toBe(false);
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
  });
  it('allows immediate reuse only after an explicit clean release', async () => {
    const first = await acquire();
    expect(await acquireTravelLease('browser')).toBeNull();
    await releaseTravelLease(first);
    const second = await acquire();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it('serializes VPN and direct browser execution when the VPN changes the system network', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    const results = await Promise.all([acquireTravelLease('vpn'), acquireTravelLease('browser')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const held = results.find(result => result !== null)!;
    expect(held.id).toBe('network');
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    expect(await claimTravelJob(job.id, held)).toMatchObject({ status: 'running', leaseResource: 'network' });
    await completeTravelJob(job.id, held, async () => undefined);
    await releaseTravelLease(held);
    expect((await acquire('browser')).id).toBe('network');
  });
  it('keeps direct browsing separate when the VPN is isolated behind a proxy', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    vi.stubEnv('EXPRESSVPN_SOCKS_URL', 'socks5://vpn.test:1080');
    expect((await acquire('vpn')).id).toBe('vpn');
    expect((await acquire()).id).toBe('browser');
    expect(await getTravelAdmission()).toMatchObject({ systemWide: false, vpnEnabled: true });
  });
  it('quarantines conflicting replica endpoints without exposing credentials', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    await acquire();
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://private-user:private-password@other.test:8000');
    await expect(acquireTravelLease('vpn')).rejects.toMatchObject({ status: 503 });
    const status = await getTravelAdmission();
    expect(status.quarantinedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(status)).not.toMatch(/private-user|private-password|other\.test/);
  });
  it('detects changed configuration on heartbeat without waiting for another worker', async () => {
    const lease = await acquire();
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    expect(await renewTravelLease(lease)).toBe(false);
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
  });
  it('refuses a result commit after configuration changes before the next heartbeat', async () => {
    const lease = await acquire('vpn');
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    await claimTravelJob(job.id, lease);
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    await expect(completeTravelJob(job.id, lease, async () => undefined)).rejects.toMatchObject({ status: 503 });
    expect((await prisma.travelJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('running');
  });
  it('requires administrator assertions and rejects stale recovery attempts', async () => {
    const lease = await acquire();
    await quarantineTravelLease(lease, 'Browser cleanup failed');
    const generation = (await getTravelAdmission()).recoveryGeneration;
    const request = { generation, oldWorkersStopped: true, networkVerified: true };
    await expect(recoverTravelAdmission({ userId: null, isAdmin: false }, request)).rejects.toMatchObject({ status: 403 });
    await expect(recoverTravelAdmission(admin, { ...request, networkVerified: false })).rejects.toMatchObject({ status: 400 });
    await expect(recoverTravelAdmission(admin, { ...request, generation: generation - 1 })).rejects.toMatchObject({ status: 412 });
    await recoverTravelAdmission(admin, request);
    await expect(recoverTravelAdmission(admin, request)).rejects.toMatchObject({ status: 412 });
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it('prevents a recovered owner from renewing, releasing or quarantining its replacement', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    const old = await acquire();
    await quarantineTravelLease(old, 'Cleanup uncertain');
    await recover();
    const replacement = await acquire();
    expect(await acknowledgeTravelCleanup(old)).toBe(false);
    await releaseTravelLease(old);
    await quarantineTravelLease(old, 'Late cleanup error');
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://stale-worker.test:8000');
    expect(await renewTravelLease(old)).toBe(false);
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://vpn.test:8000');
    expect(await renewTravelLease(replacement)).toBe(true);
    expect(await acquireTravelLease('browser')).toBeNull();
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it('requires recovery for a legacy lease instead of assuming that an old process stopped', async () => {
    await prisma.travelLease.create({ data: { id: 'vpn', owner: 'old-runtime', expiresAt: new Date(1) } });
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
  });
  it('rejects malformed configuration without disclosing its value', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    vi.stubEnv('EXPRESSVPN_API_URL', 'malformed-private-endpoint');
    await expect(acquireTravelLease('vpn')).rejects.toMatchObject({ status: 503, message: expect.not.stringContaining('malformed-private-endpoint') });
    expect((await getTravelAdmission()).leases).toEqual([]);
  });
  it.each(['administrator', 'owner'] as const)('finalizes interrupted car, hotel and flight runs through %s recovery without deleting prior observations', async mode => {
    const query = await prisma.query.create({ data: { rawInput: 'Recovery test', origin: 'LHR', originName: 'London', destination: 'JFK', destinationName: 'New York', dateFrom: new Date('2027-05-01'), dateTo: new Date('2027-05-10'), expiresAt: new Date('2027-05-01') } });
    const car = await prisma.carSearchRun.create({ data: { request: {}, status: 'running', result: { retained: true } } });
    const hotel = await prisma.hotelSearchRun.create({ data: { request: {}, status: 'running', result: { retained: true } } });
    try {
      const browser = await acquire(), vpn = await acquire('vpn');
      const carJob = await enqueueTravelJob({ kind: 'car_search', carRunId: car.id, userId: null });
      const hotelJob = await enqueueTravelJob({ kind: 'hotel_search', hotelRunId: hotel.id, userId: null });
      const flightJob = await enqueueTravelJob({ kind: 'flight_query', queryId: query.id, userId: null });
      await claimTravelJob(carJob.id, browser); await claimTravelJob(hotelJob.id, browser); await claimTravelJob(flightJob.id, vpn);
      const run = await prisma.fetchRun.create({ data: { queryId: query.id, travelJobId: flightJob.id, status: 'in_progress' } });
      if (mode === 'administrator') {
        await quarantineTravelLease(browser, 'Worker stopped'); await recover();
      } else {
        await prisma.travelLease.updateMany({ data: { expiresAt: new Date(0) } });
        expect(await acknowledgeTravelCleanup(browser)).toBe(true);
        expect(await acknowledgeTravelCleanup(vpn)).toBe(true);
        expect((await getTravelAdmission()).quarantinedAt).toBeNull();
      }
      expect(await prisma.carSearchRun.findUnique({ where: { id: car.id } })).toMatchObject({ status: 'failed', result: { retained: true }, completedAt: expect.any(Date) });
      expect(await prisma.hotelSearchRun.findUnique({ where: { id: hotel.id } })).toMatchObject({ status: 'failed', result: { retained: true }, completedAt: expect.any(Date) });
      expect(await prisma.fetchRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'failed', completedAt: expect.any(Date) });
      expect(await prisma.travelJob.count({ where: { status: 'running' } })).toBe(0);
    } finally {
      await prisma.travelJob.deleteMany();
      await prisma.query.delete({ where: { id: query.id } });
      await prisma.carSearchRun.delete({ where: { id: car.id } });
      await prisma.hotelSearchRun.delete({ where: { id: hotel.id } });
    }
  });
});
