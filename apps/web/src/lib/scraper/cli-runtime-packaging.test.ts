import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
let temporary: string;
let root: string;
let output: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'ff-cli-runtime-'));
  root = join(temporary, 'installation'); output = join(temporary, 'runtime');
  await mkdir(join(root, 'packages/cli'), { recursive: true });
  await packageFixture('node_modules/proper-lockfile', 'proper-lockfile', '4.1.2');
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

async function packageFixture(location: string, name: string, version: string, fields: object = {}) {
  await mkdir(join(root, location), { recursive: true });
  await writeFile(join(root, location, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js', ...fields }));
  await writeFile(join(root, location, 'index.js'), 'export default {};');
}
async function stage(imports: string[]) {
  const metafile = join(temporary, 'metafile.json');
  await writeFile(metafile, JSON.stringify({ outputs: { 'index.js': { imports: imports.map(path => ({ path, external: true })) } } }));
  return exec(process.execPath, [resolve(process.cwd(), '../../scripts/stage-cli-runtime.mjs'), root, output, metafile]);
}

it('preserves workspace versions, shared React identity and complete runtime data without unrelated packages', async () => {
  await packageFixture('node_modules/react', 'react', '19.0.0');
  await packageFixture('node_modules/ink', 'ink', '7.0.0', { peerDependencies: { react: '^19' } });
  await writeFile(join(root, 'node_modules/ink/index.js'), "import react from 'react'; export default react;");
  await writeFile(join(root, 'node_modules/ink/runtime-data.bin'), 'dynamic runtime asset');
  await packageFixture('node_modules/commander', 'commander', '2.0.0');
  await packageFixture('packages/cli/node_modules/commander', 'commander', '15.0.0');
  await packageFixture('node_modules/next', 'next', '16.0.0');
  await stage(['node:fs', 'react/jsx-runtime', 'ink', 'commander']);
  await writeFile(join(output, 'packages/cli/check.mjs'), "import react from 'react'; import ink from 'ink'; if (react !== ink) throw new Error('Duplicate React');");
  await exec(process.execPath, [join(output, 'packages/cli/check.mjs')]);
  expect(JSON.parse(await readFile(join(output, 'packages/cli/node_modules/commander/package.json'), 'utf8')).version).toBe('15.0.0');
  expect(await readFile(join(output, 'node_modules/ink/runtime-data.bin'), 'utf8')).toBe('dynamic runtime asset');
  await expect(access(join(output, 'node_modules/next'))).rejects.toThrow();
  await expect(access(join(output, 'node_modules/commander'))).rejects.toThrow();
});

it('rejects a missing required dependency while permitting absent optional platform packages', async () => {
  await packageFixture('node_modules/tool', 'tool', '1.0.0', { dependencies: { required: '1.0.0' }, optionalDependencies: { 'optional-platform': '1.0.0' } });
  await expect(stage(['tool'])).rejects.toThrow(/required/);
  await packageFixture('node_modules/required', 'required', '1.0.0');
  await stage(['tool']);
  expect(await readFile(join(output, 'node_modules/required/package.json'), 'utf8')).toContain('required');
});

async function prismaFixture(fields: object = {}) {
  await packageFixture('node_modules/@prisma/client', '@prisma/client', '7.10.0', {
    peerDependencies: { prisma: '*', typescript: '>=5.4', 'runtime-peer': '*' },
    peerDependenciesMeta: { prisma: { optional: true }, typescript: { optional: true }, 'runtime-peer': { optional: true } },
    ...fields,
  });
  await packageFixture('node_modules/prisma', 'prisma', '7.10.0', { dependencies: { 'schema-tooling': '*' } });
  await packageFixture('node_modules/schema-tooling', 'schema-tooling', '1.0.0');
  await packageFixture('node_modules/typescript', 'typescript', '5.9.0');
  await packageFixture('node_modules/runtime-peer', 'runtime-peer', '1.0.0');
}

it('omits Prisma build-only peers and their tooling while retaining installed optional runtime peers', async () => {
  await prismaFixture();
  await writeFile(join(root, 'node_modules/@prisma/client/index.js'), "import runtime from 'runtime-peer'; export default runtime;");
  await stage(['@prisma/client']);
  await writeFile(join(output, 'check.mjs'), "import client from '@prisma/client'; import runtime from 'runtime-peer'; if (client !== runtime) throw new Error('Missing runtime peer');");
  await exec(process.execPath, [join(output, 'check.mjs')]);
  for (const name of ['prisma', 'typescript', 'schema-tooling']) {
    await expect(access(join(output, 'node_modules', name))).rejects.toThrow();
  }
});

it('retains Prisma tooling when independently imported or required by another runtime package', async () => {
  await prismaFixture();
  await packageFixture('node_modules/tool', 'tool', '1.0.0', { dependencies: { prisma: '*' } });
  await stage(['@prisma/client', 'tool', 'typescript']);
  await writeFile(join(output, 'check.mjs'), "import 'prisma'; import 'typescript'; import 'schema-tooling';");
  await exec(process.execPath, [join(output, 'check.mjs')]);
});

it.each(['dependencies', 'optionalDependencies'])('retains Prisma peers also declared as %s', async field => {
  await prismaFixture({ [field]: { prisma: '*', typescript: '*' } });
  await stage(['@prisma/client']);
  await writeFile(join(output, 'check.mjs'), "import 'prisma'; import 'typescript'; import 'schema-tooling';");
  await exec(process.execPath, [join(output, 'check.mjs')]);
});

it('retains Prisma tooling peers when the client declares them required', async () => {
  await prismaFixture({ peerDependenciesMeta: {} });
  await stage(['@prisma/client']);
  await writeFile(join(output, 'check.mjs'), "import 'prisma'; import 'typescript'; import 'schema-tooling';");
  await exec(process.execPath, [join(output, 'check.mjs')]);
});
