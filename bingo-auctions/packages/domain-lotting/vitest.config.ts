// Vitest config for @auction-platform/domain-lotting.
//
// Why Vitest (not Jest):
//   - Native ESM + TypeScript support out of the box (no ts-jest, no
//     babel-jest, no .mjs vs .cjs gymnastics).
//   - ~10x faster cold starts on this workspace because esbuild compiles
//     TS-to-JS on demand rather than walking a Babel/SWC plugin chain.
//   - First-class watch mode that integrates with our monorepo's hot-reload
//     development loop.
//
// How to run:
//   - Single-shot (CI / pre-push):
//       npm test --workspace=@auction-platform/domain-lotting
//   - Watch mode (during development):
//       npm run test:watch --workspace=@auction-platform/domain-lotting
//   - From workspace root (root `npm test` fans out via turbo):
//       npm test
//
// Where tests live:
//   Test files sit next to the code under test in `__tests__/` subfolders
//   and use the `*.test.ts` or `*.spec.ts` suffix. See
//   `src/normalize/__tests__/*.test.ts` for working examples.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
