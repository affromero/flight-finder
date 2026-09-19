import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, stat, cp, rm, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))); });

it('reassembles an executable application with isolated workspace dependencies and intact symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-partition-'));
  temporary.push(root);
  const source = join(root, 'application');
  const dependencies = join(root, 'dependencies');
  const combined = join(root, 'combined');
  await mkdir(join(source, 'node_modules/shared'), { recursive: true });
  await mkdir(join(source, 'apps/web/node_modules/shared'), { recursive: true });
  await mkdir(join(source, 'packages/cli'), { recursive: true });
  await writeFile(join(source, 'node_modules/shared/index.js'), "module.exports = 'root';");
  await writeFile(join(source, 'apps/web/node_modules/shared/index.js'), "module.exports = 'web';");
  await symlink('../../node_modules', join(source, 'packages/cli/node_modules'));
  await writeFile(join(source, 'apps/web/server.cjs'), "if (require('shared') !== 'web') process.exit(1);", { mode: 0o755 });
  await writeFile(join(source, 'packages/cli/check.cjs'), "if (require('shared') !== 'root') process.exit(1);");
  await exec(process.execPath, [resolve('../../scripts/partition-runtime.mjs'), source, dependencies]);
  await expect(access(join(source, 'node_modules'))).rejects.toThrow();
  await expect(access(join(dependencies, 'apps/web/server.cjs'))).rejects.toThrow();
  await cp(dependencies, combined, { recursive: true, verbatimSymlinks: true });
  await cp(source, combined, { recursive: true, verbatimSymlinks: true });
  await exec(process.execPath, [join(combined, 'apps/web/server.cjs')]);
  await exec(process.execPath, [join(combined, 'packages/cli/check.cjs')]);
  expect(await readlink(join(combined, 'packages/cli/node_modules'))).toBe('../../node_modules');
  expect((await stat(join(combined, 'apps/web/server.cjs'))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(combined, 'node_modules/shared/index.js'), 'utf8')).toContain('root');
});

it('rejects overlapping output directories before changing the application', async () => {
  const source = await mkdtemp(join(tmpdir(), 'ff-partition-'));
  temporary.push(source);
  await writeFile(join(source, 'server.js'), 'original');
  await expect(exec(process.execPath, [resolve('../../scripts/partition-runtime.mjs'), source, join(source, 'dependencies')])).rejects.toThrow('disjoint');
  expect(await readFile(join(source, 'server.js'), 'utf8')).toBe('original');
});

it('makes unchanged dependencies reproducible across build timestamps while retaining application timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-partition-'));
  temporary.push(root);
  const snapshots = [];
  for (const timestamp of [1000000000, 1700000000]) {
    const source = join(root, String(timestamp));
    const dependencies = `${source}-dependencies`;
    await mkdir(join(source, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(source, 'node_modules/pkg/index.js'), 'module.exports = 1;');
    await writeFile(join(source, 'server.js'), 'application');
    await utimes(join(source, 'node_modules/pkg/index.js'), timestamp, timestamp);
    await utimes(join(source, 'server.js'), timestamp, timestamp);
    await exec(process.execPath, [resolve('../../scripts/partition-runtime.mjs'), source, dependencies]);
    const file = await stat(join(dependencies, 'node_modules/pkg/index.js'));
    const directory = await stat(join(dependencies, 'node_modules/pkg'));
    snapshots.push({ fileTime: file.mtimeMs, directoryTime: directory.mtimeMs, mode: file.mode });
    expect((await stat(join(source, 'server.js'))).mtimeMs).toBe(timestamp * 1000);
  }
  expect(snapshots[0]).toEqual(snapshots[1]);
});
