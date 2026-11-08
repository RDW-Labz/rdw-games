// @ts-check

// ESLint flat config for the operator-web Next.js app.
//
// Why we don't extend `eslint-config-next/core-web-vitals`:
// Next 16 removed `next/dist/compiled/babel/eslint-parser` (the package
// internally referenced by eslint-config-next via @next/eslint-plugin-next).
// Extending core-web-vitals at runtime throws `Cannot find module
// 'next/dist/compiled/babel/eslint-parser'` and fails CI.
//
// Instead we use typescript-eslint + the classic react-hooks rules
// directly — same posture as apps/bidder-app and apps/field-mobile.
// This skips the Next-specific rules (e.g. <Image> vs <img>, no-html-link)
// but those weren't catching real bugs in this codebase and the
// trade-off (broken CI vs missing-a-stylistic-warning) is obvious.
//
// Posture mirrors the mobile apps:
//   - rules-of-hooks stays error
//   - exhaustive-deps is warn
//   - no-explicit-any is OFF — strict typing lives in shared packages;
//     route handlers and Supabase joins routinely cast through unknown/any
//   - no-unused-vars warns and ignores _-prefixed names
//   - no-empty-object-type off (Supabase generic helpers fire it)
//   - all v7 React Compiler rules off (we haven't adopted React Compiler)

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      '.open-next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'node_modules/**',
      // Generated content from prebuild step.
      'src/app/legal/[slug]/_content.generated.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Classic react-hooks rules only — exhaustive-deps + rules-of-hooks.
      // v7 compiler rules (set-state-in-effect, refs, purity, immutability,
      // etc.) require React Compiler adoption; not enabled here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Strict typing lives in shared packages; route handlers + Supabase
      // joins routinely cast through unknown/any.
      '@typescript-eslint/no-explicit-any': 'off',

      // Unused vars: warn, ignore _-prefixed intentional ones.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Generic React component prop types like `Record<string, never>` and
      // `{}` show up in Supabase generic helpers; this rule creates spam
      // with zero correctness wins.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
