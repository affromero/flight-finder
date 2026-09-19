import { lstat, lutimes, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [rootArg] = process.argv.slice(2);
if (!rootArg) throw new Error('Usage: prune-runtime-dependencies.mjs DEPENDENCY_ROOT');
const root = resolve(rootArg);
let removedBytes = 0;
let removedFiles = 0;
let postgresCompilerFiles = 0;

function isBuildArtifact(name) {
  return name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts');
}

function isPrismaClientRuntime(path) {
  return path.endsWith(join('node_modules', '@prisma', 'client', 'runtime'));
}

function isUnusedPrismaCompiler(path, name) {
  if (!isPrismaClientRuntime(path)) return false;
  return /^query_compiler_(?:fast|small)_bg\.(?:cockroachdb|mysql|sqlite|sqlserver)\./.test(name);
}

async function prune(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await prune(child);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isPrismaClientRuntime(path)
      && /^query_compiler_(?:fast|small)_bg\.postgresql\./.test(entry.name)) {
      postgresCompilerFiles++;
    }
    if (!isBuildArtifact(entry.name) && !isUnusedPrismaCompiler(path, entry.name)) continue;
    removedBytes += (await lstat(child)).size;
    removedFiles++;
    await rm(child);
  }
}

await prune(root);
if (postgresCompilerFiles === 0) throw new Error('PostgreSQL Prisma query compiler was not preserved');

// Removing files changes their parent directory timestamps. Reset the complete
// dependency tree so equivalent inputs still produce identical Docker layers.
async function normalizeTimes(path) {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    for (const name of await readdir(path)) await normalizeTimes(join(path, name));
  }
  await lutimes(path, 0, 0);
}
await normalizeTimes(root);
console.log(JSON.stringify({ removedBytes, removedFiles, postgresCompilerFiles }));
