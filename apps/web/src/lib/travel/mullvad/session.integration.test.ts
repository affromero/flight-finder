import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { initial, executable } from '../../../../../../scripts/vpn/tailscale-fixture.mjs';
import { acquireTravelLease, getTravelAdmission, releaseTravelLease } from '../admission';
import { cancelTravelJob, enqueueTravelJob } from '../jobs';
import { executeTravelJob } from '../executor';
import { currentTravelContext } from '../context';

describe.skipIf(process.env.TRAVEL_MULLVAD_INTEGRATION_TESTS !== '1')('Mullvad jobs through PostgreSQL, bridge HTTP and real subprocesses', () => {
  let directory: string, bridge: ChildProcess;
  let previous: { vpnProvider: string | null } | null;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || !((url.port === '55448' && url.pathname === '/mullvad_test') || (url.port === '55440' && url.pathname === '/car_test'))) {
      throw Error('Mullvad tests require disposable localhost:55448/mullvad_test or CI localhost:55440/car_test');
    }
    previous = await prisma.extractionConfig.findUnique({ where: { id: 'singleton' }, select: { vpnProvider: true } });
  });
  beforeEach(async () => {
    await prisma.travelJob.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { vpnProvider: 'mullvad' }, update: { vpnProvider: 'mullvad' } });
    directory = await mkdtemp(join(tmpdir(), 'flight-mullvad-job-'));
    for (const name of ['tailscale', 'curl']) await writeFile(join(directory, name), '#!' + process.execPath + '\n' + executable, { mode: 0o700 });
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ status: initial() }));
    bridge = spawn(process.execPath, [fileURLToPath(new URL('../../../../../../scripts/vpn/tailscale-vpn-bridge.mjs', import.meta.url))], {
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, VPN_FIXTURE_DIRECTORY: directory, VPN_BRIDGE_PORT: '0',
        TAILSCALE_VPN_SOCKS_URL: 'socks5://tailscale:1055', TAILSCALE_SOCKET: join(directory, 'dedicated.sock') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Bridge startup timed out: ' + output)), 5000);
      bridge.stderr?.on('data', chunk => { output += chunk; });
      bridge.stdout?.on('data', chunk => {
        output += chunk;
        const match = /listening on port (\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
      });
      bridge.once('exit', code => { clearTimeout(timer); reject(Error('Bridge exited ' + code + ': ' + output)); });
      bridge.once('error', error => { clearTimeout(timer); reject(error); });
    });
    vi.stubEnv('TAILSCALE_VPN_API_URL', base); vi.stubEnv('TAILSCALE_VPN_SOCKS_URL', 'socks5://tailscale:1055');
  });
  afterEach(async () => {
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) { const exited = once(bridge, 'exit'); bridge.kill('SIGTERM'); await exited; }
    if (directory) await rm(directory, { recursive: true, force: true });
    await prisma.travelJob.deleteMany(); await prisma.travelLease.deleteMany(); await prisma.travelAdmission.deleteMany();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (previous) await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: previous });
    else await prisma.extractionConfig.deleteMany({ where: { id: 'singleton' } });
    await prisma.$disconnect();
  });
  async function requests(): Promise<{ command: string; args: string[] }[]> {
    try { return (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { command: string; args: string[] }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async function waitFor(work: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw Error('Fixture state did not settle');
  }
  it('admits a VPN comparison alongside a separate browser job while serializing VPN work', async () => {
    const vpn = await acquireTravelLease('vpn'), browser = await acquireTravelLease('browser');
    expect(vpn?.id).toBe('vpn'); expect(browser?.id).toBe('browser');
    expect(await acquireTravelLease('vpn')).toBeNull();
    await releaseTravelLease(vpn!); await releaseTravelLease(browser!);
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
  });
  it.each(['endpoint', 'proxy'])('quarantines a held job when its %s identity changes', async identity => {
    await acquireTravelLease('vpn');
    if (identity === 'endpoint') vi.stubEnv('TAILSCALE_VPN_API_URL', 'http://another-bridge:8000');
    else vi.stubEnv('TAILSCALE_VPN_SOCKS_URL', 'socks5://another-daemon:1055');
    await expect(acquireTravelLease('browser')).rejects.toMatchObject({ status: 503 });
    expect((await getTravelAdmission()).quarantinedAt).not.toBeNull();
  });
  it('completes a verified comparison and independently cleans the VPN after execution disposal', async () => {
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    expect(await executeTravelJob(job.id, async () => {
      expect(await currentTravelContext()!.vpn.connect('US')).toBe(true);
      return { country: 'US', verified: true };
    })).toBe(true);
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'succeeded', result: { country: 'US', verified: true } });
    expect((await getTravelAdmission()).quarantinedAt).toBeNull();
    expect((await requests()).filter(value => value.command === 'tailscale' && value.args[1] === 'set').map(value => value.args[2]))
      .toEqual(['--exit-node=', '--exit-node=100.64.0.1', '--exit-node=']);
    const next = await acquireTravelLease('vpn'); expect(next).not.toBeNull(); await releaseTravelLease(next!);
  });
  it.each(['caller', 'persisted'] as const)('cancels an in-flight switch from the %s, kills the command and quarantines the persistent lease', async cancellation => {
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = executeTravelJob(job.id, async () => {
      const raw = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8')) as Record<string, unknown>;
      await writeFile(join(directory, 'fixture.json'), JSON.stringify({ ...raw, hold: true }));
      entered(); await currentTravelContext()!.vpn.connect('US'); return 'must not be committed';
    }, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/cleanup/i);
    await started;
    let pid = 0;
    await waitFor(async () => {
      const sent = (await requests()).some(value => value.args[2] === '--exit-node=100.64.0.1');
      if (!sent) return false;
      pid = Number(await readFile(join(directory, 'mutation.pid'), 'utf8'));
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (cancellation === 'caller') controller.abort(Error('Caller cancelled the comparison'));
    else expect(await cancelTravelJob(job.id, null, true)).toBe(true);
    await rejected;
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } });
    expect((await getTravelAdmission()).quarantinedAt).not.toBeNull();
    expect(await prisma.travelJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: cancellation === 'caller' ? 'failed' : 'cancelled', result: null });
    expect((await requests()).filter(value => value.command === 'tailscale' && value.args[1] === 'set').map(value => value.args[2]))
      .toEqual(['--exit-node=', '--exit-node=100.64.0.1']);
    await expect(acquireTravelLease('vpn')).rejects.toMatchObject({ status: 503 });
  });
  it('cancels preparation before the work callback and quarantines an unfinished disconnect', async () => {
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ status: initial(), hold: true }));
    const job = await enqueueTravelJob({ kind: 'flight_batch', userId: null });
    const controller = new AbortController();
    let worked = false;
    const pending = executeTravelJob(job.id, async () => { worked = true; return 'unreachable'; }, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/cleanup/i);
    await waitFor(async () => {
      try { await readFile(join(directory, 'mutation.pid')); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    });
    controller.abort(Error('Preparation cancelled')); await rejected;
    expect(worked).toBe(false);
    expect((await getTravelAdmission()).quarantinedAt).not.toBeNull();
    expect((await requests()).filter(value => value.command === 'tailscale' && value.args[1] === 'set').map(value => value.args[2])).toEqual(['--exit-node=']);
  });
});
