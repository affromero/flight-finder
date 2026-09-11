import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliRoot = path.dirname(fileURLToPath(import.meta.url));

// Map @/ to CLI's own src/ directory.
// The scraper modules in apps/web/src/lib/scraper/ import @/lib/prisma and @/lib/redis.
// By pointing @/ here, those imports resolve to our local shims in packages/cli/src/lib/
// which are framework-agnostic copies (no Next.js dependencies).
const cliSrc = path.resolve(cliRoot, 'src');
const generatedSrc = path.resolve(cliRoot, '../../apps/web/src/generated');

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/generated/')) {
    return nextResolve(pathToFileURL(path.join(generatedSrc, specifier.slice('@/generated/'.length))).href, context);
  }
  if (specifier.startsWith('@/')) {
    const absolute = path.join(cliSrc, specifier.slice(2));
    return nextResolve(pathToFileURL(absolute).href, context);
  }
  return nextResolve(specifier, context);
}
