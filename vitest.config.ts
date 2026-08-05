import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The dashboard's own alias, so UI logic can be unit tested without
      // standing up Next.js.
      '@': path.resolve(__dirname, 'apps/web/src'),
    },
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
