import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { launchBrowser } from '../scraper/browser';
import type { Browser } from 'playwright';
import { executeTravelJob, pumpTravelJobs } from './coordinator';
import { expireQueuedPreviews, withPreviewTravelAdmission } from './preview';
import { acquireTravelLease, getTravelAdmission, recoverTravelAdmission, releaseTravelLease } from './admission';
import { cancelTravelJob, enqueueTravelJob } from './jobs';
import { travelDelay } from './execution';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe.skipIf(process.env.TRAVEL_COORDINATOR_INTEGRATION_TESTS !== '1')('shared coordinator over PostgreSQL and headless Chromium', () => {
  let previous: { vpnProvider: string | null } | null;
  const browsers: Browser[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || url.port !== '55440' || url.pathname !== '/car_test') throw new Error('Coordinator tests require disposable localhost:55440/car_test');
    previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { vpnProvider: true } });
  });
  beforeEach(async () => {
    await prisma.travelJob.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { vpnProvider: 'none' }, update: { vpnProvider: 'none' } });
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    for (const browser of browsers.splice(0)) if (browser.isConnected()) await browser.close();
    await prisma.travelJob.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
  });
  afterAll(async () => {
    if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previous });
    else await prisma.extractionConfig.delete({ where: { id: 'singleton' } });
    await prisma.$disconnect();
  });
  async function browser() { const value = await launchBrowser(); browsers.push(value); return value; }
  const batch = () => enqueueTravelJob({ kind: 'flight_batch', userId: null });

  it('waits for a busy browser lease and returns preview data without persisting sensitive output', async () => {
    const held = await acquireTravelLease('browser');
    const work = withPreviewTravelAdmission(async () => {
      const page = await (await browser()).newPage();
      await page.setContent('<h1>Private preview result</h1>');
      return { text: await page.textContent('h1'), credential: 'memory-only-secret' };
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(browsers).toHaveLength(0);
    await releaseTravelLease(held!);
    expect(await work).toMatchObject({ text: 'Private preview result', credential: 'memory-only-secret' });
    const jobs = await prisma.travelJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'flight_preview', status: 'succeeded', result: null, request: null });
    expect(JSON.stringify(jobs)).not.toContain('memory-only-secret');
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
  }, 15_000);

  it('does not let the background worker consume a process-owned preview and only expires abandoned queued work', async () => {
    vi.stubEnv('SELF_HOSTED', 'true');
    const abandoned = await enqueueTravelJob({ kind: 'flight_preview', userId: null });
    const fresh = await enqueueTravelJob({ kind: 'flight_preview', userId: null });
    await prisma.travelJob.update({ where: { id: abandoned.id }, data: { createdAt: new Date(Date.now() - 600_000) } });
    await pumpTravelJobs();
    expect(await prisma.travelJob.findUnique({ where: { id: fresh.id } })).toMatchObject({ status: 'queued', attempts: 0 });
    await expireQueuedPreviews();
    expect(await prisma.travelJob.findUnique({ where: { id: abandoned.id } })).toMatchObject({ status: 'failed', attempts: 0 });
    expect(await prisma.travelJob.findUnique({ where: { id: fresh.id } })).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it.each(['queued', 'running'] as const)('cancels a %s preview without accepting a result or leaving a browser', async state => {
    const held = state === 'queued' ? await acquireTravelLease('browser') : null;
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = withPreviewTravelAdmission(async () => {
      await browser(); started(); await travelDelay(30_000); return 'must not be accepted';
    }, { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow(/caller cancelled/);
    if (state === 'running') await ready;
    else await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort(new Error('caller cancelled'));
    await rejected;
    if (held) await releaseTravelLease(held);
    const jobs = await prisma.travelJob.findMany();
    expect(jobs[0]).toMatchObject({ status: state === 'queued' ? 'cancelled' : 'failed', result: null });
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  }, 15_000);

  it('preserves a preview callback error and quarantines unverified cleanup', async () => {
    await expect(withPreviewTravelAdmission(async () => {
      const opened = await browser(), close = opened.close.bind(opened);
      vi.spyOn(opened, 'close').mockImplementation(async () => { await close(); throw new Error('cleanup acknowledgement lost'); });
      throw new Error('original preview error');
    })).rejects.toMatchObject({ name: 'TravelCleanupError' });
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
    expect((await prisma.travelJob.findFirst())?.result).toBeNull();
  }, 15_000);

  it('persists the result and closes owned browsers before the resource becomes reusable', async () => {
    const job = await batch();
    expect(await executeTravelJob(job.id, async () => {
      const page = await (await browser()).newPage();
      await page.setContent('<title>Verified worker result</title>');
      return { title: await page.title() };
    })).toBe(true);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'succeeded', result: { title: 'Verified worker result' } });
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    const replacement = await acquireTravelLease('vpn'); expect(replacement).not.toBeNull();
    await releaseTravelLease(replacement!);
  }, 15_000);

  it('does not execute the same queued job twice across concurrent workers', async () => {
    const job = await batch();
    const outcomes = await Promise.all([0, 1].map(() => executeTravelJob(job.id, async () => {
      const page = await (await browser()).newPage(); await page.setContent('<title>One accepted execution</title>');
      await travelDelay(100); return { title: await page.title() };
    })));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(browsers).toHaveLength(1);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'succeeded', attempts: 1 });
  }, 15_000);

  it('observes cancellation during browser work and releases only after the browser closes', async () => {
    const job = await batch();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = executeTravelJob(job.id, async () => {
      await browser(); started(); await travelDelay(30_000); return { unaccepted: true };
    });
    const rejected = expect(work).rejects.toThrow(/cancelled/);
    await ready; await cancelTravelJob(job.id, null, true); await rejected;
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'cancelled', result: null });
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
    const next = await acquireTravelLease('vpn'); expect(next).not.toBeNull(); await releaseTravelLease(next!);
  }, 15_000);

  it('closes browsers and fails interrupted work after expiry, then permits a fresh search', async () => {
    const job = await batch();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = executeTravelJob(job.id, async () => { await browser(); started(); await travelDelay(30_000); });
    const rejected = expect(work).rejects.toThrow();
    await ready;
    await prisma.travelLease.update({ where: { id: 'vpn' }, data: { expiresAt: new Date(0) } });
    await rejected;
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'failed', result: null });
    const next = await batch();
    expect(await executeTravelJob(next.id, async () => ({ fresh: true }))).toBe(true);
    expect(await prisma.travelJob.findUnique({ where: { id: next.id } })).toMatchObject({ status: 'succeeded', result: { fresh: true } });
  }, 15_000);

  it('keeps admission blocked until a delayed browser close acknowledges completion', async () => {
    let started!: () => void, finishClose!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const closing = new Promise<void>(resolve => { finishClose = resolve; });
    const job = await batch();
    const work = executeTravelJob(job.id, async () => {
      const opened = await browser(), close = opened.close.bind(opened);
      vi.spyOn(opened, 'close').mockImplementation(async () => { started(); await closing; await close(); });
      await prisma.travelLease.update({ where: { id: 'vpn' }, data: { expiresAt: new Date(0) } });
      await travelDelay(30_000);
      return { stale: true };
    });
    const rejected = expect(work).rejects.toThrow();
    await ready;
    try {
      await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
      expect(browsers.some(browser => browser.isConnected())).toBe(true);
    } finally { finishClose(); }
    await rejected;
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'failed', result: null });
  }, 15_000);

  it('retains quarantine when browser cleanup fails after a heartbeat detects expiry', async () => {
    const job = await batch();
    await expect(executeTravelJob(job.id, async () => {
      const opened = await browser(), close = opened.close.bind(opened);
      vi.spyOn(opened, 'close').mockImplementation(async () => { await close(); throw new Error('Cleanup acknowledgement lost after interruption'); });
      await prisma.travelLease.update({ where: { id: 'vpn' }, data: { expiresAt: new Date(0) } });
      await travelDelay(30_000);
    })).rejects.toMatchObject({ name: 'TravelCleanupError' });
    expect(await prisma.travelAdmission.findUnique({ where: { id: 'singleton' } })).toMatchObject({ quarantinedAt: expect.any(Date), cleanupRecoveryAllowed: false });
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'running', result: null });
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
  }, 15_000);

  it('rejects results produced after expiry even before the next heartbeat runs', async () => {
    const job = await batch();
    await expect(executeTravelJob(job.id, async () => {
      await prisma.travelLease.update({ where: { id: 'vpn' }, data: { expiresAt: new Date(0) } });
      return { stale: true };
    })).rejects.toThrow();
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'failed', result: null });
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('recovers after a real worker process is suspended past its lease and resumed', async () => {
    const job = await batch();
    const worker = fork(fileURLToPath(new URL('../../test/travel-interruption-worker.ts', import.meta.url)), [job.id], {
      execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) },
    });
    let output = '';
    worker.stderr?.on('data', chunk => { output += String(chunk); });
    const finished = new Promise<number | null>(resolve => { worker.once('exit', resolve); });
    const ready = new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', () => resolve());
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })
      .then(() => { throw new Error(`Interrupted worker did not settle: ${output}`); });
    try {
      await Promise.race([ready, timeout, finished.then(code => { throw new Error(`Worker exited before starting (${code}): ${output}`); })]);
      worker.kill('SIGSTOP');
      // Advance the persisted deadline instead of keeping CI asleep for two minutes.
      await prisma.travelLease.update({ where: { id: 'vpn' }, data: { expiresAt: new Date(0) } });
      await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
      worker.kill('SIGCONT');
      expect(await Promise.race([finished, timeout]), output).toBe(0);
      expect((await getTravelAdmission()).quarantinedAt).toBeNull();
      expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'failed', result: null });
      const next = await batch();
      expect(await executeTravelJob(next.id, async () => ({ resumed: true }))).toBe(true);
    } finally {
      clearTimeout(timer);
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGCONT'); worker.kill('SIGTERM');
        const force = setTimeout(() => worker.kill('SIGKILL'), 1000);
        try { await finished; } finally { clearTimeout(force); }
      }
    }
  }, 15_000);

  it('leaves queued work available during quarantine and resumes after administrator recovery', async () => {
    const held = await acquireTravelLease('browser');
    await prisma.travelLease.update({ where: { id: held!.id }, data: { expiresAt: new Date(0) } });
    const job = await batch();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await pumpTravelJobs(); await pumpTravelJobs();
    expect(errors.mock.calls).toEqual([]);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'queued', attempts: 0 });
    const incident = await getTravelAdmission();
    await recoverTravelAdmission({ userId: null, isAdmin: true }, { generation: incident.recoveryGeneration, oldWorkersStopped: true, networkVerified: true });
    expect(await executeTravelJob(job.id, async () => ({ resumed: true }))).toBe(true);
  });

  it('quarantines cleanup failure and retains the failed cleanup evidence', async () => {
    const job = await batch();
    await expect(executeTravelJob(job.id, async () => {
      const opened = await browser(), close = opened.close.bind(opened);
      vi.spyOn(opened, 'close').mockImplementation(async () => { await close(); throw new Error('Browser transport cleanup acknowledgement lost'); });
      return { unaccepted: true };
    })).rejects.toMatchObject({ name: 'TravelCleanupError' });
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'running', result: null });
    await expect(acquireTravelLease('vpn')).rejects.toMatchObject({ status: 503 });
  }, 15_000);

  it('excludes direct browsers while an admitted job owns the system-wide VPN', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://vpn.test'); vi.stubEnv('EXPRESSVPN_SOCKS_URL', '');
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push(url);
      if (init.method !== 'GET' || !url.endsWith('/v1/status')) throw new Error('Unexpected VPN mutation');
      return new Response('Not connected');
    });
    const job = await batch();
    await executeTravelJob(job.id, async () => {
      await browser();
      expect(await acquireTravelLease('browser')).toBeNull();
      expect((await getTravelAdmission()).systemWide).toBe(true);
    });
    expect(requests.every(url => url === 'http://vpn.test/v1/status')).toBe(true);
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    const next = await acquireTravelLease('browser'); expect(next?.id).toBe('network'); await releaseTravelLease(next!);
  }, 15_000);

  it('requires manual recovery after VPN lease expiry without sending a late network mutation', async () => {
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { vpnProvider: 'expressvpn' } });
    vi.stubEnv('EXPRESSVPN_API_URL', 'http://vpn.test'); vi.stubEnv('EXPRESSVPN_SOCKS_URL', '');
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url}`);
      if (init.method !== 'GET' || !url.endsWith('/v1/status')) throw new Error('Unexpected VPN mutation');
      return new Response('Not connected');
    });
    const job = await batch();
    await expect(executeTravelJob(job.id, async () => {
      await browser();
      await prisma.travelLease.update({ where: { id: 'network' }, data: { expiresAt: new Date(0) } });
      await travelDelay(30_000);
    })).rejects.toThrow();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request === 'GET http://vpn.test/v1/status')).toBe(true);
    expect(browsers.every(browser => !browser.isConnected())).toBe(true);
    expect((await getTravelAdmission()).quarantinedAt).toBeInstanceOf(Date);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'running', result: null });
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
  }, 15_000);
});
