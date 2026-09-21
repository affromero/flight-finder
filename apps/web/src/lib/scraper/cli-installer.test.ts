import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
let root: string;
let prefix: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ff-cli-installer-test-'));
  prefix = join(root, 'managed');
  await mkdir(join(root, 'commands'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function npmFixture(fail = false, observed = '0.153.4', pause = false) {
  await writeFile(join(root, 'commands', 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const installation = process.argv[process.argv.indexOf('--prefix') + 1];
fs.mkdirSync(path.join(installation, 'node_modules', '.bin'), { recursive: true });
fs.writeFileSync(path.join(installation, 'partial-download'), 'downloaded data');
if (${pause}) {
  fs.writeFileSync(${JSON.stringify(join(root, 'started'))}, 'ready');
  while (!fs.existsSync(${JSON.stringify(join(root, 'release'))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (${fail}) process.exit(1);
fs.writeFileSync(path.join(installation, 'node_modules', '.bin', 'codex'), ${JSON.stringify(`#!${process.execPath}\nconsole.log('codex-cli ${observed}');\n`)}, { mode: 0o755 });
`, { mode: 0o755 });
}
function install(version = '0.153.4') {
  return exec(process.execPath, [resolve(process.cwd(), '../../scripts/update-cli.mjs'), 'codex'], {
    env: { ...process.env, PATH: `${join(root, 'commands')}:${process.env.PATH}`, NPM_CONFIG_PREFIX: prefix, CODEX_VERSION: version },
  });
}

it('installs a verified executable and skips an already matching version', async () => {
  await npmFixture();
  expect(JSON.parse((await install()).stdout)).toMatchObject({ changed: true, version: '0.153.4' });
  await npmFixture(true);
  expect(JSON.parse((await install()).stdout)).toMatchObject({ changed: false });
  expect((await exec(join(prefix, 'bin', 'codex'), ['--version'])).stdout).toContain('0.153.4');
});

it('preserves the previous executable and removes a failed download', async () => {
  await npmFixture(false, '0.137.0');
  await install('0.137.0');
  const before = await readdir(join(prefix, 'flight-finder-versions'));
  await npmFixture(true);
  await expect(install()).rejects.toThrow(/previous CLI remains available/);
  expect(await readdir(join(prefix, 'flight-finder-versions'))).toEqual(before);
  expect((await exec(join(prefix, 'bin', 'codex'), ['--version'])).stdout).toContain('0.137.0');
});

it('rejects an incorrect downloaded version without replacing the current CLI or authentication', async () => {
  await npmFixture(false, '0.137.0');
  await install('0.137.0');
  const authentication = join(prefix, 'auth.json');
  await writeFile(authentication, 'private auth sentinel', { mode: 0o600 });
  await expect(install()).rejects.toThrow(/did not match/);
  expect((await exec(join(prefix, 'bin', 'codex'), ['--version'])).stdout).toContain('0.137.0');
  expect(await readFile(authentication, 'utf8')).toBe('private auth sentinel');
  expect(await readdir(join(prefix, 'flight-finder-versions'))).toHaveLength(1);
}, 15_000);

it('activates a verified upgrade while leaving the previous executable runnable', async () => {
  await npmFixture(false, '0.137.0');
  await install('0.137.0');
  const previous = await realpath(join(prefix, 'bin', 'codex'));
  await npmFixture();
  expect(JSON.parse((await install()).stdout)).toMatchObject({ changed: true, version: '0.153.4' });
  expect((await exec(join(prefix, 'bin', 'codex'), ['--version'])).stdout).toContain('0.153.4');
  expect((await exec(previous, ['--version'])).stdout).toContain('0.137.0');
}, 15_000);

it('cleans an unactivated installation when the executable destination cannot be replaced', async () => {
  await mkdir(join(prefix, 'bin', 'codex'), { recursive: true });
  await writeFile(join(prefix, 'bin', 'codex', 'keep'), 'existing destination');
  await npmFixture();
  await expect(install()).rejects.toThrow();
  expect(await readFile(join(prefix, 'bin', 'codex', 'keep'), 'utf8')).toBe('existing destination');
  expect(await readdir(join(prefix, 'flight-finder-versions'))).toEqual([]);
  expect(await readdir(join(prefix, 'bin'))).toEqual(['codex']);
});

it('serializes overlapping upgrades and keeps both verified executables runnable', async () => {
  await npmFixture(false, '0.137.0', true);
  const first = install('0.137.0');
  await expect.poll(() => readFile(join(root, 'started'), 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('ready');
  await npmFixture(false, '0.153.4');
  const second = install('0.153.4');
  await writeFile(join(root, 'release'), 'continue');
  await Promise.all([first, second]);
  expect((await exec(join(prefix, 'bin', 'codex'), ['--version'])).stdout).toContain('0.153.4');
  const installations = await readdir(join(prefix, 'flight-finder-versions'));
  expect(installations).toHaveLength(2);
  const old = installations.find(name => name.startsWith('codex-0.137.0-'))!;
  expect((await exec(join(prefix, 'flight-finder-versions', old, 'node_modules/.bin/codex'), ['--version'])).stdout).toContain('0.137.0');
}, 15_000);

it('startup maintenance retains the newest versions, active CLI and unknown installations', async () => {
  await npmFixture(); await install();
  const versions = join(prefix, 'flight-finder-versions');
  const proc = join(root, 'proc'); await mkdir(proc);
  const oldTime = Date.now() - 3 * 24 * 60 * 60_000;
  for (const [name, time] of [['codex-0.1.0-oldold', oldTime], ['codex-0.2.0-backup', oldTime + 1], ['codex-0.3.0-recent', Date.now()]] as const) {
    await mkdir(join(versions, name));
    await writeFile(join(versions, name, 'activation.json'), JSON.stringify({ binary: 'codex', version: name.split('-')[1], activatedAt: time }));
  }
  await mkdir(join(versions, 'unknown-installation'));
  const module = resolve(process.cwd(), '../../scripts/cli-retention.mjs');
  await exec(process.execPath, ['--input-type=module', '-e', `import {mkdir,writeFile} from 'node:fs/promises'; import {retainCliVersions} from ${JSON.stringify(module)}; const proc=${JSON.stringify(proc)}; await mkdir(proc+'/'+process.pid); await writeFile(proc+'/'+process.pid+'/status','PPid: 1'); await mkdir(proc+'/1'); await writeFile(proc+'/1/cmdline','/bin/sh\\0/app/docker-entrypoint.sh\\0'); await retainCliVersions(${JSON.stringify(prefix)}, {procRoot:proc});`]);
  const retained = await readdir(versions);
  expect(retained).not.toContain('codex-0.1.0-oldold');
  expect(retained).toContain('codex-0.3.0-recent');
  expect(retained).not.toContain('codex-0.2.0-backup');
  expect(retained).toContain('unknown-installation');
  expect((await exec(join(prefix, 'bin/codex'), ['--version'])).stdout).toContain('0.153.4');
});

it('refuses version cleanup when a managed CLI process is still running', async () => {
  await npmFixture(); await install();
  const proc = join(root, 'proc', '999999'); await mkdir(proc, { recursive: true });
  await writeFile(join(proc, 'cmdline'), `node\0${join(prefix, 'bin/codex')}\0`);
  const before = await readdir(join(prefix, 'flight-finder-versions'));
  const module = resolve(process.cwd(), '../../scripts/cli-retention.mjs');
  await expect(exec(process.execPath, ['--input-type=module', '-e', `import {retainCliVersions} from ${JSON.stringify(module)}; await retainCliVersions(${JSON.stringify(prefix)}, {procRoot:${JSON.stringify(join(root, 'proc'))}});`])).rejects.toThrow(/process is running/);
  expect(await readdir(join(prefix, 'flight-finder-versions'))).toEqual(before);
});

it('refuses maintenance launched by the running web server', async () => {
  await npmFixture(); await install();
  const proc = join(root, 'proc'); await mkdir(proc);
  const before = await readdir(join(prefix, 'flight-finder-versions'));
  const module = resolve(process.cwd(), '../../scripts/cli-retention.mjs');
  await expect(exec(process.execPath, ['--input-type=module', '-e', `import {mkdir,writeFile} from 'node:fs/promises'; import {retainCliVersions} from ${JSON.stringify(module)}; const proc=${JSON.stringify(proc)}; await mkdir(proc+'/'+process.pid); await writeFile(proc+'/'+process.pid+'/status','PPid: 1'); await mkdir(proc+'/1'); await writeFile(proc+'/1/cmdline','node\\0/app/apps/web/server.js\\0'); await retainCliVersions(${JSON.stringify(prefix)}, {procRoot:proc});`])).rejects.toThrow(/startup ancestry/);
  expect(await readdir(join(prefix, 'flight-finder-versions'))).toEqual(before);
});
