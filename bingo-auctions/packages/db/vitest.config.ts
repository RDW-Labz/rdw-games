// Vitest config for @auction-platform/db.
//
// Only the test/ directory is included. The place_bid load test is gated
// behind PLACE_BID_LOAD=1 at runtime — this config just makes the file
// discoverable so CI can confirm the module compiles and the smoke test
// passes without a live Supabase stack.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
