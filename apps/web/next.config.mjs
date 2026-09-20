import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Monorepo root, so Next traces workspace files into the standalone build
// instead of only inferring the root (which it warns about in 16).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Keep the ESM worker and its relative shared-module import together. Emitting
// either as an independently hashed URL leaves the worker's import unresolved.
const mapDist = dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
const mapVersion = JSON.parse(readFileSync(join(mapDist, '../package.json'), 'utf8')).version;
const mapAssets = join(dirname(fileURLToPath(import.meta.url)), 'public/maplibre', mapVersion);
mkdirSync(mapAssets, { recursive: true });
for (const asset of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(join(mapDist, asset), join(mapAssets, asset));
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_MAPLIBRE_VERSION: mapVersion },
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: { '/*': ['./data/car-locations/**/*'] },
  serverExternalPackages: [
    'playwright',
    'better-sqlite3',
    'geoip-lite',
    'cron',
    'ioredis',
    'ua-parser-js',
    '@anthropic-ai/sdk',
    'openai',
    '@google/generative-ai',
    'thesidedoor-flock',
  ],
};

export default withNextIntl(nextConfig);
