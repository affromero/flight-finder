import { mkdir, readdir, rm, lstat, chmod, chown, lutimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// Move complete dependency directories without following workspace symlinks.
// Both outputs retain the original paths so Docker can overlay them unchanged.
const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) throw new Error('Usage: partition-runtime.mjs SOURCE DEPENDENCIES');
const source = resolve(sourceArg);
const destination = resolve(destinationArg);
if (source === destination || destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) {
  throw new Error('Runtime output directories must be disjoint');
}

async function partition(relative = '') {
  const directory = join(source, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() && !(entry.name === 'node_modules' && entry.isSymbolicLink())) continue;
    const child = join(relative, entry.name);
    if (entry.name !== 'node_modules') {
      await partition(child);
      continue;
    }
    const parent = join(destination, relative);
    await mkdir(parent, { recursive: true });
    const metadata = await lstat(directory);
    await chmod(parent, metadata.mode);
    await chown(parent, metadata.uid, metadata.gid);
    // OverlayFS cannot rename directories inherited from a lower image layer.
    execFileSync('cp', ['-a', join(source, child), join(destination, child)]);
    await rm(join(source, child), { recursive: true });
  }
}

await partition();

// Next traces copy unchanged packages with fresh timestamps. Normalize only the
// dependency output so equivalent package trees produce identical image layers.
async function normalizeTimes(path) {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    for (const name of await readdir(path)) await normalizeTimes(join(path, name));
  }
  await lutimes(path, 0, 0);
}
await mkdir(destination, { recursive: true });
await normalizeTimes(destination);
