import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))); });

it('keeps executable packages and the PostgreSQL compiler while removing build artifacts and other database compilers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-runtime-prune-'));
  temporary.push(root);
  const runtime = join(root, 'node_modules/@prisma/client/runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'client.mjs'), 'export const client = true;');
  await writeFile(join(runtime, 'client.mjs.map'), '{}');
  await writeFile(join(runtime, 'client.d.mts'), 'export declare const client: boolean;');
  await writeFile(join(runtime, 'query_compiler_fast_bg.postgresql.mjs'), 'export const wasm = true;');
  await writeFile(join(runtime, 'query_compiler_fast_bg.postgresql.wasm-base64.mjs'), 'export const wasm = true;');
  await writeFile(join(runtime, 'query_compiler_fast_bg.mysql.mjs'), 'unused');
  await writeFile(join(runtime, 'query_compiler_small_bg.sqlite.js'), 'unused');
  const { stdout } = await exec(process.execPath, [resolve('../../scripts/prune-runtime-dependencies.mjs'), root]);
  const result = JSON.parse(stdout) as { removedFiles: number; postgresCompilerFiles: number };
  expect(result).toEqual(expect.objectContaining({ removedFiles: 4, postgresCompilerFiles: 2 }));
  expect(await readFile(join(runtime, 'client.mjs'), 'utf8')).toContain('client');
  expect(await readFile(join(runtime, 'query_compiler_fast_bg.postgresql.mjs'), 'utf8')).toContain('wasm');
  await expect(access(join(runtime, 'query_compiler_fast_bg.mysql.mjs'))).rejects.toThrow();
  await expect(access(join(runtime, 'client.d.mts'))).rejects.toThrow();
  expect((await stat(runtime)).mtimeMs).toBe(0);
});

it('does not treat similarly named packages as the Prisma client runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-runtime-prune-'));
  temporary.push(root);
  const runtime = join(root, 'node_modules/@prisma/client-other/node_modules/@prisma/client-other/runtime');
  const prismaRuntime = join(root, 'node_modules/@prisma/client/runtime');
  await mkdir(runtime, { recursive: true });
  await mkdir(prismaRuntime, { recursive: true });
  await writeFile(join(runtime, 'query_compiler_fast_bg.mysql.mjs'), 'keep');
  await writeFile(join(prismaRuntime, 'query_compiler_fast_bg.postgresql.mjs'), 'keep');
  await exec(process.execPath, [resolve('../../scripts/prune-runtime-dependencies.mjs'), root]);
  expect(await readFile(join(runtime, 'query_compiler_fast_bg.mysql.mjs'), 'utf8')).toBe('keep');
});

it('fails when pruning a dependency tree without the required PostgreSQL compiler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-runtime-prune-'));
  temporary.push(root);
  await mkdir(join(root, 'node_modules/example'), { recursive: true });
  await writeFile(join(root, 'node_modules/example/index.js'), 'module.exports = true;');
  await expect(exec(process.execPath, [resolve('../../scripts/prune-runtime-dependencies.mjs'), root])).rejects.toThrow('PostgreSQL');
  expect(await readFile(join(root, 'node_modules/example/index.js'), 'utf8')).toContain('true');
});
