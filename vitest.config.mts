import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: [
      { find: /^@serverforge\/(core|adapters|db)$/, replacement: path.resolve(import.meta.dirname, 'packages/$1/src/index.ts') },
      { find: /^@serverforge\/core\/(.+)$/, replacement: path.resolve(import.meta.dirname, 'packages/core/src/$1.ts') },
      { find: '@', replacement: path.resolve(import.meta.dirname, 'apps/web/src') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    // Node by default; files needing a DOM opt in with
    // `// @vitest-environment happy-dom` at the top.
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
    },
  },
});
