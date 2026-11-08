// Vitest config for @auction-platform/operator-web unit tests.
//
// Scope: pure-logic modules only (extractors, helpers, lib utilities).
// Next.js App Router internals are NOT tested here — use the Playwright
// e2e suite for integration coverage.
//
// How to run:
//   npm test --workspace=@auction-platform/operator-web
// Watch mode:
//   npm run test:watch --workspace=@auction-platform/operator-web

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
