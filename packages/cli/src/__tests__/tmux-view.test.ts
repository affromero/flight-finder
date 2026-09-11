import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const boundary = vi.hoisted(() => ({
  execSync: vi.fn(), spawnSync: vi.fn(), spawn: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), disconnect: vi.fn(),
}));
vi.mock('child_process', () => ({ execSync: boundary.execSync, spawnSync: boundary.spawnSync, spawn: boundary.spawn }));
vi.mock('@/lib/prisma', () => ({ prisma: { query: { findUnique: boundary.findUnique, findMany: boundary.findMany }, $disconnect: boundary.disconnect } }));

import { launchTmuxView } from '../lib/tmux-view.js';

let directory = '';
let originalArgv: string[];
let originalExecArgv: string[];
const trackerId = "tracker ' quoted; literal";

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  directory = await mkdtemp(join(tmpdir(), 'flight tmux '));
  originalArgv = process.argv;
  originalExecArgv = process.execArgv;
  process.argv = [process.execPath, join(directory, 'entry.js')];
  process.execArgv = [];
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.stubEnv('DATABASE_URL', 'postgresql://caller:fixture@localhost/caller');
  vi.stubEnv('FLIGHT_FINDER_BACKEND', 'openai');
  vi.stubEnv('TMUX', 'existing-server');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  boundary.execSync.mockReturnValue('');
  boundary.spawn.mockReturnValue({ unref() {} });
  const tracker = { id: trackerId, origin: 'YUL', destination: 'NRT', dateFrom: new Date('2027-04-15'), groupId: null };
  boundary.findUnique.mockResolvedValue(tracker);
  boundary.findMany.mockResolvedValue([tracker]);
  boundary.disconnect.mockResolvedValue(undefined);
  let selectedPane = '0';
  boundary.spawnSync.mockImplementation((command: string, args: string[]) => {
    if (args[0] === 'split-window') selectedPane = '1';
    let stdout = '';
    if (args.includes('#{session_name}')) stdout = 'work';
    if (args.includes('#{window_index}')) stdout = '2';
    if (args.includes('#{pane_index}')) stdout = selectedPane;
    return { status: 0, stdout, stderr: '' };
  });
});

afterEach(async () => {
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('forwards caller configuration to new panes without writing secrets into shell commands', async () => {
  await launchTmuxView(trackerId);
  const split = boundary.spawnSync.mock.calls.find(([, args]) => args[0] === 'split-window')?.[1] as string[];
  expect(split).toContain(`DATABASE_URL=${process.env.DATABASE_URL}`);
  expect(split).not.toContain('TMUX=existing-server');
  const command = boundary.spawnSync.mock.calls.find(([, args]) => args[0] === 'send-keys')?.[1][1] as string;
  expect(command).not.toContain('postgresql://');
  await writeFile(join(directory, 'entry.js'), "require('node:fs').writeFileSync(process.env.TMUX_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));\n");
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const output = join(directory, 'args.json');
  await promisify(actual.execFile)('/bin/sh', ['-c', command], { env: { ...process.env, TMUX_TEST_OUTPUT: output } });
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(['--headless', '--view', trackerId]);
});

it('closes the initiating pane rather than the newly selected viewer', async () => {
  await launchTmuxView(trackerId);
  await vi.runAllTimersAsync();
  const removed = boundary.spawnSync.mock.calls.filter(([, args]) => args[0] === 'kill-pane').map(([, args]) => args);
  expect(removed).toEqual([['kill-pane', '-t', 'work:2.0']]);
});

it('forwards injected configuration when creating a separate tmux session', async () => {
  vi.stubEnv('TMUX', '');
  await launchTmuxView(trackerId);
  const session = boundary.spawnSync.mock.calls.find(([, args]) => args[0] === 'new-session')?.[1] as string[];
  expect(session).toContain(`DATABASE_URL=${process.env.DATABASE_URL}`);
  expect(session).toContain('FLIGHT_FINDER_BACKEND=openai');
});

it('reports tmux failures even when the process supplies no diagnostic text', async () => {
  boundary.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
  await expect(launchTmuxView(trackerId)).rejects.toThrow(/tmux command failed/);
});

it('reports a failed terminal attachment when Ghostty is unavailable', async () => {
  vi.stubEnv('TMUX', '');
  boundary.execSync.mockImplementation((command: string) => {
    if (command.includes('ghostty')) throw new Error('not installed');
    return '';
  });
  boundary.spawnSync.mockImplementation((_command: string, args: string[]) => ({
    status: args[0] === 'attach-session' ? 1 : 0, stdout: '', stderr: '',
  }));
  await expect(launchTmuxView(trackerId)).rejects.toThrow('tmux attach-session failed');
});
