// Vitest config for @auction-platform/shared.
//
// Picks up the pure-unit tests colocated in src/ (e.g. bidding.test.ts, the
// SQL↔client bid-increment parity suite). No environment setup needed — these
// are pure functions with no DOM / network.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
