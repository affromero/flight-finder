import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
function packageName(specifier) {
  if (builtins.has(specifier)) return null;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || specifier.startsWith('.')) throw new Error(`Unsupported external import: ${specifier}`);
  return name;
}

async function locate(root, from, name) {
  let directory = from;
  while (directory === root || directory.startsWith(`${root}${sep}`)) {
    const candidate = join(directory, 'node_modules', name);
    try {
      const actual = await realpath(candidate);
      if (!actual.startsWith(`${root}${sep}`)) throw new Error(`Dependency escapes installation: ${name}`);
      const metadata = JSON.parse(await readFile(join(actual, 'package.json'), 'utf8'));
      if (metadata.name !== name) throw new Error(`Dependency name mismatch: ${name}`);
      return { directory: actual, metadata };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return null;
}

/** Copy complete runtime packages, retaining npm's hoisted identity and native/data files. */
export async function stageCliRuntime(rootPath, outputPath, metafilePath) {
  const root = await realpath(rootPath);
  const output = resolve(outputPath);
  if (output === root || output.startsWith(`${root}${sep}`)) throw new Error('Runtime staging must be outside the dependency installation');
  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'));
  const imports = Object.values(metafile.outputs).flatMap(item => item.imports.filter(entry => entry.external).map(entry => entry.path));
  const queue = imports.map(packageName).filter(Boolean).map(name => ({ name, from: join(root, 'packages/cli'), optional: false }));
  queue.push({ name: 'proper-lockfile', from: root, optional: false });
  const copied = new Set();
  const packages = [];
  for (const request of queue) {
    const found = await locate(root, request.from, request.name);
    if (!found) {
      if (request.optional) continue;
      throw new Error(`Required CLI runtime dependency is missing: ${request.name}`);
    }
    if (copied.has(found.directory)) continue;
    copied.add(found.directory);
    const location = relative(root, found.directory);
    if (isAbsolute(location) || location.startsWith('..') || !location.split(sep).includes('node_modules')) throw new Error(`Unsupported dependency location: ${location}`);
    const destination = join(output, location);
    await mkdir(dirname(destination), { recursive: true });
    let bytes = 0;
    await cp(found.directory, destination, { recursive: true, dereference: false, filter: async source => {
      if (source !== found.directory && source.split(sep).at(-1) === 'node_modules') return false;
      const info = await stat(source);
      if (info.isFile()) bytes += info.size;
      return true;
    } });
    packages.push({ name: found.metadata.name, version: found.metadata.version, location, bytes });
    const required = found.metadata.dependencies ?? {};
    const optional = found.metadata.optionalDependencies ?? {};
    const peers = found.metadata.peerDependencies ?? {};
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional), ...Object.keys(peers)])) {
      // The generated client needs neither the schema CLI nor the TypeScript compiler.
      // Exclude only these build-time peer edges; independent runtime imports still win.
      if (found.metadata.name === '@prisma/client' && (name === 'prisma' || name === 'typescript')
        && Object.hasOwn(peers, name) && found.metadata.peerDependenciesMeta?.[name]?.optional === true
        && !Object.hasOwn(required, name) && !Object.hasOwn(optional, name)) continue;
      queue.push({ name, from: found.directory, optional: Object.hasOwn(optional, name) || (!Object.hasOwn(required, name) && found.metadata.peerDependenciesMeta?.[name]?.optional === true) });
    }
  }
  packages.sort((a, b) => a.location.localeCompare(b.location));
  const manifest = { bytes: packages.reduce((sum, item) => sum + item.bytes, 0), packages };
  await writeFile(join(output, 'cli-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, output, metafile] = process.argv.slice(2);
  if (!root || !output || !metafile) throw new Error('Usage: stage-cli-runtime.mjs installation output metafile');
  const manifest = await stageCliRuntime(root, output, metafile);
  console.log(`CLI runtime: ${manifest.packages.length} packages, ${manifest.bytes} bytes`);
}
