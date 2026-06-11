import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Monorepo root, so Next traces workspace files into the standalone build
// instead of only inferring the root (which it warns about in 16).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
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
  ],
};

export default nextConfig;
