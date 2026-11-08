// Vitest config for @auction-platform/bidder-app.
//
// Scope: PURE logic modules only (lib/*.ts with no React and no native
// modules). Anything touching expo-* native code, AppState or a component tree
// needs a device — use the Maestro suite in e2e/maestro for that.
//
// Mirrors apps/operator-web/vitest.config.ts.
//
// How to run:
//   npm test --workspace=@auction-platform/bidder-app

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.{test,spec}.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
