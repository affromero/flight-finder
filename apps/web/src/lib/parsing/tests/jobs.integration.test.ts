import { createServer, type ServerResponse } from 'node:http';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { providerVault } from '@/lib/sidedoor/providers/provider-credentials';
import { serializable } from '@/lib/sidedoor/access/transaction';
import { captureParseConfiguration } from '../configuration';
import { enqueueParse, claimParseJob, readParseJob, parseRecoveryStatus, recoverParseReservation } from '../jobs';
import { executeNextParse } from '../executor';

describe.skipIf(process.env.PARSE_INTEGRATION_TESTS !== '1')('durable parsing through PostgreSQL and provider HTTP', () => {
  const input = { query: 'JFK to LAX tomorrow' };
  const actor = { ownerId: 'parse-owner' };
  const second = { ownerId: 'parse-member' };
  let endpoint = '';
  let held = false;
  let broken = false;
  let requests: Record<string, unknown>[] = [];
  let pending: ServerResponse[] = [];
  const children: ChildProcess[] = [];
  const server = createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += String(chunk);
    requests.push(JSON.parse(bytes) as Record<string, unknown>);
    if (held) { pending.push(response); return; }
    answer(response);
  });
  function answer(response: ServerResponse) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'parse-fixture', model: 'fixture', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: broken ? 'private malformed fixture' : JSON.stringify({ confidence: 'high', ambiguities: [], parsed: {
        origins: [{ code: 'JFK', name: 'New York' }], destinations: [{ code: 'LAX', name: 'Los Angeles' }], dateFrom: '2026-10-07', dateTo: '2026-10-07', tripType: 'one_way', cabinClass: 'economy',
      } }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
  }
  async function until(condition: () => Promise<boolean> | boolean) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Parse fixture did not settle');
  }
  function worker(mode = 'execute') {
    const child = fork(fileURLToPath(new URL('../../../test/parsing/worker.ts', import.meta.url)), [mode], {
      execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) },
    });
    children.push(child);
    let diagnostics = '';
    child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    const finished = new Promise<{ claimed: string | boolean | null }>((resolve, reject) => {
      child.once('message', message => resolve(message as { claimed: string | boolean | null }));
      child.once('error', reject);
      child.once('exit', code => { if (code) reject(Error(`Parse worker exited ${code}: ${diagnostics}`)); });
    });
    return { child, finished };
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== '127.0.0.1' || !((url.port === '55448' && url.pathname === '/parse_test') || (url.port === '55440' && url.pathname === '/car_test')))
      throw Error('Parse tests require disposable localhost:55448/parse_test or CI localhost:55440/car_test');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing provider fixture address');
    endpoint = `http://127.0.0.1:${address.port}/v1`;
  });
  beforeEach(async () => {
    await prisma.parseJob.deleteMany(); await prisma.parseReservation.deleteMany(); await prisma.apiUsageLog.deleteMany();
    await prisma.user.upsert({ where: { id: actor.ownerId }, create: { id: actor.ownerId, username: actor.ownerId }, update: {} });
    await prisma.user.upsert({ where: { id: second.ownerId }, create: { id: second.ownerId, username: second.ownerId }, update: {} });
    await prisma.extractionConfig.upsert({ where: { id: 'singleton' }, create: { provider: 'ollama', model: 'fixture', enabled: false }, update: { provider: 'ollama', model: 'fixture', enabled: false, customBaseUrl: null, extractTimeoutSeconds: 90 } });
    await serializable(async database => providerVault(database).vault.configure('ollama', { baseUrl: endpoint }));
    held = false; broken = false; requests = []; pending = [];
  });
  afterEach(async () => {
    for (const response of pending) response.destroy();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGCONT'); child.kill('SIGKILL'); await exited; }
    }
    await prisma.parseJob.deleteMany(); await prisma.parseReservation.deleteMany(); await prisma.apiUsageLog.deleteMany();
    await prisma.user.deleteMany({ where: { id: { in: [actor.ownerId, second.ownerId] } } });
    vi.unstubAllEnvs();
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });

  it('deduplicates only effective history within the same owner, date and configuration', async () => {
    const first = await enqueueParse({ ...input, conversationHistory: [{ role: 'user', content: 'x'.repeat(2000) + 'tail' }] }, actor, 'ip-one');
    const repeat = await enqueueParse({ ...input, conversationHistory: [{ role: 'user', content: 'x'.repeat(2000) + 'different tail' }] }, actor, 'ip-one');
    expect(repeat.id).toBe(first.id);
    expect((await enqueueParse(input, second, 'ip-two')).id).not.toBe(first.id);
    expect((await enqueueParse({ ...input, conversationHistory: [{ role: 'user', content: 'different prompt' }] }, actor, 'ip-one')).id).not.toBe(first.id);
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { model: 'changed' } });
    expect((await enqueueParse(input, actor, 'ip-one')).id).not.toBe(first.id);
  });
  it('uses anonymous capabilities only for anonymous jobs and never shares query-global results', async () => {
    const one = await enqueueParse(input, { ownerId: null }, 'ip-one');
    const two = await enqueueParse(input, { ownerId: null }, 'ip-two');
    expect(two.id).not.toBe(one.id);
    expect((await enqueueParse(input, { ownerId: null, capability: one.capability }, 'ip-one')).id).toBe(one.id);
    await expect(readParseJob(one.id, { ownerId: null })).rejects.toMatchObject({ status: 404 });
    await expect(readParseJob(one.id, { ownerId: null, capability: two.capability })).rejects.toMatchObject({ status: 404 });
    expect((await readParseJob(one.id, { ownerId: null, capability: one.capability })).status).toBe('queued');
    const owned = await enqueueParse(input, actor, 'ip-one');
    await expect(readParseJob(owned.id, { ownerId: second.ownerId, capability: one.capability })).rejects.toMatchObject({ status: 404 });
    await expect(readParseJob(owned.id, { ownerId: null, capability: one.capability })).rejects.toMatchObject({ status: 404 });
    expect(await prisma.parseJob.findUnique({ where: { id: one.id } })).not.toMatchObject({ capabilityHash: one.capability });
  });
  it('runs queued work after a process restart through one canonical usage record and captured prompt date', async () => {
    const job = await enqueueParse(input, actor, 'ip-one');
    await prisma.parseJob.update({ where: { id: job.id }, data: { promptDate: '2025-12-31' } });
    const process = worker();
    expect(await process.finished).toMatchObject({ claimed: true });
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'completed', result: { confidence: 'high', parsed: { origin: 'JFK', destination: 'LAX' } } });
    expect(requests[0]).toMatchObject({ model: 'fixture' });
    expect(JSON.stringify(requests[0])).toContain('2025-12-31');
    expect(await prisma.apiUsageLog.findMany()).toMatchObject([{ operation: 'parse-query', inputTokens: 12, outputTokens: 8 }]);
  });
  it('admits one claim across competing processes and keeps parser capacity separate from travel leases', async () => {
    const job = await enqueueParse(input, actor, 'ip-one');
    const results = await Promise.all([worker('claim').finished, worker('claim').finished]);
    expect(results.filter(result => result.claimed === job.id)).toHaveLength(1);
    expect(results.filter(result => result.claimed === null)).toHaveLength(1);
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(1);
    expect(await prisma.travelLease.count()).toBe(0);
  });
  it('fails queued configuration changes explicitly while unrelated preferences leave authority unchanged', async () => {
    const before = await serializable(captureParseConfiguration);
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { theme: 'changed', providerRevision: { increment: 1 } } });
    expect((await serializable(captureParseConfiguration)).fingerprint).toBe(before.fingerprint);
    const job = await enqueueParse(input, actor, 'ip-one');
    await serializable(async database => providerVault(database).vault.configure('ollama', { baseUrl: `${endpoint}/changed` }));
    expect(await executeNextParse()).toBe(true);
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'failed', error: 'configuration_changed' });
    expect(requests).toEqual([]);
  });
  it('cancels a live HTTP generation without releasing capacity before settlement or publishing a result', async () => {
    held = true;
    const job = await enqueueParse(input, actor, 'ip-one');
    const execution = executeNextParse();
    await until(() => requests.length > 0);
    expect((await readParseJob(job.id, actor, true)).status).toBe('cancelled');
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(1);
    await execution;
    await until(() => pending.every(response => response.destroyed));
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'cancelled' });
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(0);
    expect((await prisma.parseJob.findUnique({ where: { id: job.id } }))?.result).toBeNull();
  }, 15_000);
  it('retains execution authority after owner deletion until the provider settles', async () => {
    held = true;
    await enqueueParse(input, actor, 'ip-one');
    const execution = executeNextParse();
    await until(() => requests.length > 0);
    await prisma.user.delete({ where: { id: actor.ownerId } });
    expect(await prisma.parseJob.count()).toBe(0);
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(1);
    await execution;
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(0);
  }, 15_000);
  it('aborts an active provider when its configured authority changes and rejects the old response', async () => {
    held = true;
    const job = await enqueueParse(input, actor, 'ip-one');
    const execution = executeNextParse();
    await until(() => requests.length > 0);
    await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { model: 'new-authority' } });
    await execution;
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'failed', error: 'configuration_changed' });
    expect((await prisma.parseJob.findUnique({ where: { id: job.id } }))?.result).toBeNull();
    expect(requests).toHaveLength(1);
  }, 15_000);
  it('stops a held HTTP call at its persisted execution deadline', async () => {
    held = true;
    const job = await enqueueParse(input, actor, 'ip-one');
    const execution = executeNextParse();
    await until(() => requests.length > 0);
    await prisma.parseReservation.updateMany({ where: { jobId: job.id }, data: { deadline: new Date(0) } });
    await execution;
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(0);
    await until(() => pending.every(response => response.destroyed));
  }, 15_000);
  it.skipIf(process.platform === 'win32')('kills real CLI descendants on persisted cancellation without freeing capacity early', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flight-parse-cli-'));
    const executable = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
fs.writeFileSync(path.join(__dirname, 'pids.json'), JSON.stringify([process.pid, child.pid]));
process.stdin.resume();
setInterval(() => {}, 1000);
`;
    try {
      await writeFile(join(directory, 'codex'), executable, { mode: 0o700 });
      vi.stubEnv('PATH', directory + ':' + process.env.PATH);
      await prisma.extractionConfig.update({ where: { id: 'singleton' }, data: { provider: 'codex', model: 'fixture', reasoningEffort: null } });
      const job = await enqueueParse(input, actor, 'ip-one');
      const execution = executeNextParse();
      let pids: number[] = [];
      await until(async () => { try { pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')) as number[]; return pids.length === 2; } catch { return false; } });
      expect((await readParseJob(job.id, actor, true)).status).toBe('cancelled');
      expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(1);
      await execution;
      await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }));
      expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(0);
      expect((await prisma.parseJob.findUnique({ where: { id: job.id } }))?.result).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
  it('blocks capacity after a stopped worker and requires fenced recovery without retrying its job', async () => {
    const job = await enqueueParse(input, actor, 'ip-one');
    const claim = await claimParseJob();
    expect(claim?.job.id).toBe(job.id);
    await expect(recoverParseReservation(claim!.reservation.id, claim!.reservation.generation, 'owner')).rejects.toMatchObject({ status: 412 });
    await prisma.parseReservation.update({ where: { id: claim!.reservation.id }, data: { leaseUntil: new Date(0) } });
    await prisma.parseJob.update({ where: { id: job.id }, data: { leaseUntil: new Date(0) } });
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'failed', error: 'worker_interrupted' });
    const next = await enqueueParse({ query: 'JFK to LAX Friday' }, second, 'ip-two');
    expect(await claimParseJob()).toBeNull();
    expect(await parseRecoveryStatus()).toMatchObject([{ id: claim!.reservation.id }]);
    await expect(recoverParseReservation(claim!.reservation.id, claim!.reservation.generation + 1, 'owner')).rejects.toMatchObject({ status: 412 });
    await recoverParseReservation(claim!.reservation.id, claim!.reservation.generation, 'owner');
    expect((await claimParseJob())?.job.id).toBe(next.id);
    expect((await readParseJob(job.id, actor)).status).toBe('failed');
  });
  it.skipIf(process.platform === 'win32')('rejects a result from a suspended process whose persisted authority expired', async () => {
    held = true;
    const job = await enqueueParse(input, actor, 'ip-one');
    const execution = worker();
    await Promise.race([until(() => requests.length > 0), execution.finished.then(() => { throw Error('Worker settled before its held provider call'); })]);
    execution.child.kill('SIGSTOP');
    await prisma.parseReservation.updateMany({ where: { jobId: job.id }, data: { leaseUntil: new Date(0) } });
    await prisma.parseJob.update({ where: { id: job.id }, data: { leaseUntil: new Date(0) } });
    expect((await readParseJob(job.id, actor)).status).toBe('failed');
    execution.child.kill('SIGCONT');
    for (const response of pending) answer(response);
    await execution.finished;
    expect((await prisma.parseJob.findUnique({ where: { id: job.id } }))?.result).toBeNull();
    expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(0);
  }, 15_000);
  it('bounds owner queues and expires abandoned queued and completed input independently', async () => {
    const queued = await Promise.all(Array.from({ length: 4 }, (_, index) => enqueueParse({ query: `JFK to LAX date ${index}` }, actor, 'ip-one')));
    await expect(enqueueParse({ query: 'JFK to LAX fifth' }, actor, 'ip-one')).rejects.toMatchObject({ status: 429 });
    await prisma.parseJob.update({ where: { id: queued[0]!.id }, data: { queueUntil: new Date(0) } });
    expect((await readParseJob(queued[0]!.id, actor)).error).toBe('queue_timeout');
    await prisma.parseJob.update({ where: { id: queued[1]!.id }, data: { expiresAt: new Date(0) } });
    await expect(readParseJob(queued[1]!.id, actor)).rejects.toMatchObject({ status: 404 });
    expect((await enqueueParse({ query: 'JFK to LAX fifth' }, actor, 'ip-one')).status).toBe('queued');
  });
  it('redacts malformed provider failures while retaining canonical measured usage', async () => {
    broken = true;
    const job = await enqueueParse(input, actor, 'ip-one');
    await executeNextParse();
    expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'failed', error: 'provider_failed' });
    expect(JSON.stringify(await readParseJob(job.id, actor))).not.toContain('private malformed');
    expect(await prisma.apiUsageLog.findMany()).toMatchObject([{ inputTokens: 12, outputTokens: 8 }]);
  });
  it('settles local execution within its database bound when usage persistence is locked', async () => {
    const job = await enqueueParse(input, actor, 'ip-one');
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const lock = prisma.$transaction(async database => {
      await database.$executeRaw`LOCK TABLE "ApiUsageLog" IN ACCESS EXCLUSIVE MODE`;
      locked();
      await unlock;
    }, { timeout: 15_000 });
    await ready;
    try {
      const began = Date.now();
      await executeNextParse();
      expect(Date.now() - began).toBeLessThan(5000);
      expect(await readParseJob(job.id, actor)).toMatchObject({ status: 'failed', error: 'usage_unavailable' });
      expect(await prisma.parseReservation.count({ where: { settledAt: null } })).toBe(0);
      expect(requests).toHaveLength(1);
    } finally { release(); await lock; }
    expect(await prisma.apiUsageLog.count()).toBe(0);
  }, 15_000);
  it('enforces the persisted IP and global queue caps across rotating anonymous capabilities', async () => {
    for (let index = 0; index < 32; index++) {
      await enqueueParse(input, { ownerId: null }, `ip-${Math.floor(index / 8)}`);
      if (index === 7) await expect(enqueueParse(input, { ownerId: null }, 'ip-0')).rejects.toMatchObject({ status: 429 });
    }
    await expect(enqueueParse(input, { ownerId: null }, 'ip-0')).rejects.toMatchObject({ status: 429 });
    await expect(enqueueParse(input, { ownerId: null }, 'new-ip')).rejects.toMatchObject({ status: 429 });
    const jobs = await prisma.parseJob.findMany({ orderBy: { createdAt: 'asc' } });
    // Expiry reopens one queue slot without reviving any existing private job.
    await prisma.parseJob.update({ where: { id: jobs[0]!.id }, data: { queueUntil: new Date(0) } });
    expect((await enqueueParse(input, { ownerId: null }, 'new-ip')).status).toBe('queued');
    await expect(enqueueParse(input, { ownerId: null }, 'ip-1')).rejects.toMatchObject({ status: 429 });
  }, 30_000);
});
