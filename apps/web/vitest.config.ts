import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    // Default to node. .test.tsx files opt into jsdom via the
    // `/** @vitest-environment jsdom */` directive at the top of each file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globalSetup: ['src/test/llmock-setup.ts'],
    setupFiles: ['src/test/setup.ts', 'src/test/setup-dom.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/app/api/**/*.ts'],
      exclude: ['src/test/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // tsconfig uses jsx: 'preserve' for Next.js. Vitest 4 transforms with oxc
  // (rolldown) instead of esbuild and silently ignores the esbuild option,
  // so configure both for forward and backward compatibility.
  esbuild: {
    jsx: 'automatic',
  },
  oxc: {
    jsx: { runtime: 'automatic' },
  },
});
