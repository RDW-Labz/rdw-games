#!/usr/bin/env node
// Generates apps/operator-web/src/app/legal/[slug]/_content.generated.ts
// from the markdown files in legal/.
//
// Why: the operator-web runs as a Cloudflare Worker, which has no filesystem
// access to the repo-root `legal/` directory. fs.readFileSync() always fails.
// We embed the markdown into a bundled TypeScript module instead. The route
// imports from the generated module and never touches fs at runtime.
//
// Run automatically as part of `npm run build` via the prebuild hook in
// apps/operator-web/package.json. Safe to run manually:
//
//   node scripts/generate-legal-content.mjs
//
// The generated file is checked into git so a clean clone can build without
// needing to run codegen first.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const LEGAL_DOCS = [
  { slug: 'terms', file: 'terms.md' },
  { slug: 'privacy', file: 'privacy.md' },
  { slug: 'bidder-agreement', file: 'bidder-agreement.md' },
  { slug: 'dmca-policy', file: 'dmca-policy.md' },
  { slug: 'prohibited-items', file: 'prohibited-items.md' },
];

const OUT = join(
  REPO_ROOT,
  'apps/operator-web/src/app/legal/[slug]/_content.generated.ts',
);

// Escape a markdown blob for safe embedding in a TS template literal:
//   `  -> \`
//   $  -> \$  (only when followed by { — otherwise $ is literal in template)
//   \  -> \\
//
// We escape every $ to be conservative; markdown rarely uses $ outside money
// amounts where literal expansion is safe but the escape is harmless.
function escapeForTemplate(content) {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

const entries = LEGAL_DOCS.map(({ slug, file }) => {
  const path = join(REPO_ROOT, 'legal', file);
  const stat = statSync(path);
  const content = readFileSync(path, 'utf8');
  const escaped = escapeForTemplate(content);
  return {
    slug,
    file,
    bytes: stat.size,
    escaped,
  };
});

const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
const generatedAt = new Date().toISOString();

const body = `// AUTO-GENERATED FILE. Do not edit by hand.
//
// Source: legal/*.md at repo root.
// Regenerate: node scripts/generate-legal-content.mjs
// Auto-runs: apps/operator-web prebuild hook.
//
// Generated: ${generatedAt}
// Total bytes embedded: ${totalBytes}

export const LEGAL_CONTENT: Record<string, string> = {
${entries
  .map(
    (e) =>
      `  // ${e.file} (${e.bytes} bytes)\n  '${e.slug}': \`${e.escaped}\`,`,
  )
  .join('\n\n')}
};
`;

writeFileSync(OUT, body, 'utf8');

// eslint-disable-next-line no-console
console.log(
  `[generate-legal-content] wrote ${OUT} (${entries.length} docs, ${totalBytes} bytes total)`,
);
