import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', '--import', './packages/cli/register.mjs', 'packages/cli/src/index.tsx', ...args], {
      cwd: root,
      timeout: 15_000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', SELF_HOSTED: 'true', REDIS_URL: '',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unavailable?connect_timeout=1', ...env },
    }, (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, stdout, stderr }));
  });
}

describe('flight CLI entrypoint alongside hotel and car commands', () => {
  let directory = '';
  let server: Server;
  let serverUrl = '';
  const paths: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'flight-cli-entrypoint-'));
    server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { scope: 'user:test', isAdmin: false, trackers: [], nextCursor: null } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server port');
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('shows help successfully when no command is requested', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--headless');
    expect(result.stdout).toContain('hotels');
    expect(result.stdout).toContain('cars');
  });

  it('validates flight options before attempting a backend change', async () => {
    const result = await runCli(['--json', '--backend', 'openai', '--tmux']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toContain('--headless');
    expect(result.stdout).toBe('');
  });

  it('requires a tracker for tmux mode', async () => {
    const result = await runCli(['--headless', '--tmux']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--view');
  });

  it('validates account recovery arguments instead of printing general help', async () => {
    const result = await runCli(['--reset-password', 'someone']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--new-password');
  });

  it('reports a JSON database error from the flight handler', async () => {
    const result = await runCli(['--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBeTruthy();
    expect(result.stdout).toBe('');
  });

  it('surfaces a failed backend save as a JSON error and exits', async () => {
    const result = await runCli(['--backend', 'openai', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBeTruthy();
    expect(result.stdout).toBe('');
  });

  it.each(['hotels', 'cars'])('dispatches %s without falling through to flight handling', async (command) => {
    paths.length = 0;
    const result = await runCli([command, '--server', serverUrl, '--json', 'list'], { HOME: directory });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ trackers: [] });
    expect(paths.some(path => path.startsWith(`/api/${command}`))).toBe(true);
  });

  it('passes the browser URL as a literal argument without executing shell text', async () => {
    const output = join(directory, 'opened-url.json');
    await writeFile(join(directory, 'open'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.OPEN_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const result = await runCli(['--view', 'tracker";exit 42;#'], {
      PATH: `${directory}:${process.env.PATH}`, OPEN_OUTPUT: output, FLIGHT_FINDER_URL: serverUrl,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual([`${serverUrl}/q/tracker%22%3Bexit%2042%3B%23`]);
  });
});
