import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { cliUpdateInfo, updateManagedCli } from './cli-update';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), set: vi.fn(), eval: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: boundary.spawn }));
vi.mock('node:fs', () => ({ existsSync: boundary.exists }));
vi.mock('../redis', () => ({ redis: { set: boundary.set, eval: boundary.eval } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('INSTALL_CLI_PROVIDERS', 'true');
  vi.stubEnv('NPM_CONFIG_PREFIX', '/managed-cli');
  vi.stubEnv('CODEX_VERSION', '0.153.4');
  boundary.exists.mockReturnValue(true);
  boundary.set.mockResolvedValue('OK');
  boundary.eval.mockResolvedValue(1);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function receipt(output: unknown, code = 0) {
  boundary.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { child.stdout.write(JSON.stringify(output)); child.emit('close', code); });
    return child;
  });
}

it('offers managed updates only when the installation owns its CLI', () => {
  expect(cliUpdateInfo('codex')).toMatchObject({ managedUpdate: true, targetVersion: '0.153.4' });
  vi.stubEnv('INSTALL_CLI_PROVIDERS', 'false');
  expect(cliUpdateInfo('codex').managedUpdate).toBe(false);
});

it('verifies an update receipt and releases only its own admission lock', async () => {
  receipt({ provider: 'codex', version: '0.153.4', changed: true });
  await expect(updateManagedCli('codex')).resolves.toEqual({ provider: 'codex', version: '0.153.4', changed: true });
  const owner = boundary.set.mock.calls[0]?.[1];
  expect(owner).toEqual(expect.any(String));
  expect(boundary.eval.mock.calls[0]?.slice(1)).toEqual([1, 'cli-managed-update', owner]);
});

it('does not start another update while one holds admission', async () => {
  boundary.set.mockResolvedValue(null);
  await expect(updateManagedCli('codex')).rejects.toThrow(/recently started/);
  expect(boundary.spawn).not.toHaveBeenCalled();
});

it('does not expose infrastructure details when admission fails', async () => {
  boundary.set.mockRejectedValue(new Error('redis://secret@internal-host'));
  await expect(updateManagedCli('codex')).rejects.toThrow('admission control is unavailable');
  expect(boundary.spawn).not.toHaveBeenCalled();
});

it('rejects a mismatched version instead of claiming the update succeeded', async () => {
  receipt({ provider: 'codex', version: '0.137.0', changed: true });
  await expect(updateManagedCli('codex')).rejects.toThrow(/acknowledgement/);
});

it('reports a failed installer and makes a subsequent attempt possible', async () => {
  receipt({}, 1);
  await expect(updateManagedCli('codex')).rejects.toThrow(/previous installation/);
  expect(boundary.eval.mock.calls[0]?.slice(1, 3)).toEqual([1, 'cli-managed-update']);
});

it('does not pass application secrets into the installer', async () => {
  vi.stubEnv('DATABASE_URL', 'private-database');
  vi.stubEnv('CRON_SECRET', 'private-cron-secret');
  receipt({ provider: 'codex', version: '0.153.4', changed: false });
  await updateManagedCli('codex');
  const options = boundary.spawn.mock.calls[0]?.[2];
  expect(options.env).not.toHaveProperty('DATABASE_URL');
  expect(options.env).not.toHaveProperty('CRON_SECRET');
  expect(options.env).toMatchObject({ NPM_CONFIG_PREFIX: '/managed-cli', CODEX_VERSION: '0.153.4' });
});

it('stops a hung installer before admission expires and reports uncertain activation', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { child.emit('close', null); return true; });
  boundary.spawn.mockReturnValue(child);
  const pending = expect(updateManagedCli('codex')).rejects.toThrow(/activation status is uncertain/);
  await vi.advanceTimersByTimeAsync(210_000);
  await pending;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(boundary.eval.mock.calls[0]?.slice(1, 3)).toEqual([1, 'cli-managed-update']);
});
