// Path-only `needs-braden` labeler (#720 item 3).
// Run: node --test scripts/__tests__/needs-braden-label.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES,
  changedPaths,
  collectChangedPaths,
  collectFileList,
  classifyPaths,
  classifyPrFiles,
  pathVariants,
} from '../ci/needs-braden-label.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/needs-braden-label.yml'), 'utf8');
const SCRIPT = readFileSync(join(ROOT, 'scripts/ci/needs-braden-label.mjs'), 'utf8');

const labels = (files) => classifyPaths(files).needsBraden;

test('a migration applies needs-braden', () => {
  assert.equal(labels(['packages/db/migrations/0488_return_lots.sql']), true);
  assert.equal(labels(['supabase/migrations/20260101_thing.sql']), true);
});

test('money, refund and Member Pro paths apply needs-braden', () => {
  assert.equal(labels(['apps/operator-web/src/lib/square.ts']), true);
  assert.equal(labels(['apps/operator-web/src/app/api/refunds/route.ts']), true);
  assert.equal(labels(['apps/operator-web/src/app/(operator)/member-pro/page.tsx']), true);
  assert.equal(labels(['scripts/prod-rig/payments-backfill.sql']), true);
});

test('money-daily, reports/money and shared money paths apply needs-braden', () => {
  const real = [
    'apps/operator-web/src/lib/money-daily.ts',
    'apps/operator-web/src/app/(operator)/reports/money/page.tsx',
    'apps/operator-web/src/components/MoneyDailyTable.tsx',
    'packages/shared/src/money.ts',
    'packages/domain-lotting/src/normalize/money.ts',
  ];
  for (const path of real) assert.equal(labels([path]), true, path);
});

test('CamelCase money and refund paths apply needs-braden', () => {
  const real = [
    'apps/field-mobile/components/RefundItemsSheet.tsx',
    'apps/operator-web/src/app/(operator)/lots/[id]/RelistAfterRefundPanel.tsx',
    'apps/operator-web/src/app/(operator)/pickups/v2/InvoicePaymentPill.tsx',
    'apps/operator-web/src/app/(operator)/settings/policies/TaxDocuments.tsx',
  ];
  for (const path of real) assert.equal(labels([path]), true, path);
});

test('ordinary CamelCase source does not apply the label', () => {
  assert.equal(labels(['apps/operator-web/src/components/ButtonGroup.tsx']), false);
  assert.equal(labels(['apps/field-mobile/lib/formatDate.ts']), false);
});

test('CamelCase rename origins still apply the label', () => {
  const files = [
    {
      filename: 'apps/field-mobile/components/NotesSheet.tsx',
      previous_filename: 'apps/field-mobile/components/RefundItemsSheet.tsx',
    },
  ];
  assert.equal(labels(files), true);
});

test('path variants split lower-to-upper and acronym boundaries', () => {
  assert.deepEqual(pathVariants('RefundItemsSheet.tsx'), [
    'RefundItemsSheet.tsx',
    'Refund-Items-Sheet.tsx',
  ]);
  assert.deepEqual(pathVariants('HTTPServer.ts'), ['HTTPServer.ts', 'HTTP-Server.ts']);
  assert.deepEqual(pathVariants('lowercase.ts'), ['lowercase.ts']);
});

test('CI, gate scripts and rule files apply needs-braden', () => {
  assert.equal(labels(['.github/workflows/ci.yml']), true);
  assert.equal(labels(['scripts/grok/ship-gate.mjs']), true);
  assert.equal(labels(['scripts/ci/needs-braden-label.mjs']), true);
  assert.equal(labels(['AGENTS.md']), true);
  assert.equal(labels(['.cursor/rules/project-swarm.mdc']), true);
  assert.equal(labels(['docs/state/bots.md']), true);
  assert.equal(labels(['docs/state/redteam-findings.md']), true);
});

test('staff app UI applies needs-braden', () => {
  assert.equal(labels(['apps/field-mobile/app/(staff)/lot/[id].tsx']), true);
});

test('docs and ordinary source do not apply the label', () => {
  assert.equal(labels(['docs/STATE.md']), false);
  assert.equal(labels(['README.md']), false);
  assert.equal(labels(['apps/bidder-app/src/components/BidButton.tsx']), false);
  assert.equal(labels(['apps/field-mobile/lib/format.ts']), false);
  assert.equal(labels([]), false);
});

test('a rename out of a sensitive path still applies the label', () => {
  const files = [
    {
      filename: 'docs/old-migration-notes.md',
      previous_filename: 'packages/db/migrations/0488_return_lots.sql',
    },
  ];
  assert.equal(labels(files), true);
  assert.ok(changedPaths(files).includes('packages/db/migrations/0488_return_lots.sql'));
});

test('every changed-file page is read, past the 100-file REST cap', () => {
  const page = (offset) =>
    Array.from({ length: 100 }, (_, i) => ({
      filename: `apps/bidder-app/src/components/Item${offset + i}.tsx`,
    }));
  const pages = [page(0), page(100), [{ filename: 'packages/db/migrations/0489_last.sql' }]];
  const paths = collectChangedPaths(pages);
  assert.equal(paths.length, 201);
  assert.equal(paths.at(-1), 'packages/db/migrations/0489_last.sql');
  assert.equal(classifyPaths(paths).needsBraden, true);
});

test('a single-page response is accepted and flattened', () => {
  assert.deepEqual(collectChangedPaths([{ filename: 'a.md' }, { filename: 'b.md' }]), [
    'a.md',
    'b.md',
  ]);
  assert.deepEqual(collectChangedPaths([]), []);
});

test('a complete file list is classified normally', () => {
  const verdict = classifyPrFiles({
    pages: [[{ filename: 'apps/bidder-app/src/components/Item.tsx' }]],
    changedFiles: 1,
  });
  assert.equal(verdict.needsBraden, false);
  assert.equal(verdict.incomplete, false);
});

test('a rename cannot inflate the changed-file completeness count', () => {
  const rename = [
    {
      filename: 'apps/bidder-app/src/components/Notes.tsx',
      previous_filename: 'apps/bidder-app/src/components/OldNotes.tsx',
    },
  ];
  assert.deepEqual(collectFileList([rename]).paths.length, 2);
  const short = classifyPrFiles({ pages: [rename], changedFiles: 2 });
  assert.equal(short.incomplete, true);
  assert.ok(short.reasons.some((r) => r.includes('incomplete')));
  assert.equal(short.needsBraden, true);

  const exact = classifyPrFiles({ pages: [rename], changedFiles: 1 });
  assert.equal(exact.incomplete, false);
});

test('duplicate filenames and excess records fail closed', () => {
  const duplicate = classifyPrFiles({
    pages: [[{ filename: 'docs/a.md' }, { filename: 'docs/a.md' }]],
    changedFiles: 2,
  });
  assert.equal(duplicate.incomplete, true);
  assert.equal(duplicate.needsBraden, true);
  assert.ok(duplicate.reasons.some((r) => r.includes('duplicate filename')));

  const excess = classifyPrFiles({
    pages: [[{ filename: 'apps/bidder-app/src/components/A.tsx' }, { filename: 'b.md' }]],
    changedFiles: 1,
  });
  assert.equal(excess.incomplete, true);
  assert.equal(excess.needsBraden, true);
  assert.ok(excess.reasons.some((r) => r.includes('more entries')));

  const complete = classifyPrFiles({
    pages: [
      [
        { filename: 'apps/bidder-app/src/components/A.tsx' },
        { filename: 'apps/bidder-app/src/components/B.tsx' },
      ],
    ],
    changedFiles: 2,
  });
  assert.equal(complete.incomplete, false);
  assert.equal(complete.needsBraden, false);

  const rename = [
    {
      filename: 'apps/bidder-app/src/components/Notes.tsx',
      previous_filename: 'apps/bidder-app/src/components/OldNotes.tsx',
    },
  ];
  const renamed = classifyPrFiles({ pages: [rename], changedFiles: 1 });
  assert.equal(renamed.incomplete, false);
});

test('a short file list fails closed to needs-braden', () => {
  const pages = [
    Array.from({ length: 3000 }, (_, i) => ({
      filename: `apps/bidder-app/src/components/Item${i}.tsx`,
    })),
  ];
  const verdict = classifyPrFiles({ pages, changedFiles: 3001 });
  assert.equal(verdict.incomplete, true);
  assert.equal(verdict.needsBraden, true);
  assert.ok(verdict.reasons.some((r) => r.includes('REST cap')));
});

test('a declared list over the REST cap fails closed even at 3,000', () => {
  const pages = [
    Array.from({ length: 3000 }, (_, i) => ({
      filename: `apps/bidder-app/src/components/Item${i}.tsx`,
    })),
  ];
  const verdict = classifyPrFiles({ pages, changedFiles: 3000 });
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.needsBraden, false);

  const overCap = classifyPrFiles({ pages, changedFiles: 3001 });
  assert.equal(overCap.incomplete, true);
  assert.ok(overCap.reasons.some((r) => r.includes('REST cap')));
});

test('malformed file entries and missing metadata fail closed', () => {
  assert.deepEqual(collectFileList([{ filename: 'a.ts' }, null]).problems, [
    'file list has a malformed entry',
  ]);
  assert.equal(
    classifyPrFiles({ pages: [{ filename: 'a.ts' }], changedFiles: null }).needsBraden,
    true,
  );
  assert.equal(classifyPrFiles({ pages: 'nope', changedFiles: 1 }).incomplete, true);
});

test('the label workflow runs trusted default-branch code, never the PR', () => {
  assert.match(WORKFLOW, /pull_request_target:/);
  assert.doesNotMatch(WORKFLOW, /^ {2}pull_request:$/m);
  assert.doesNotMatch(WORKFLOW, /pull_request\.head/);
  // A PR may target a writable non-default branch, so its base SHA is not
  // trusted code (#721 RED TEAM).
  assert.doesNotMatch(WORKFLOW, /pull_request\.base\.sha/);
  assert.doesNotMatch(WORKFLOW, /pull_request\.base\.ref/);
  assert.match(WORKFLOW, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  assert.match(WORKFLOW, /persist-credentials:\s*false/);
  assert.match(WORKFLOW, /node scripts\/ci\/needs-braden-label\.mjs "\$PR"/);
});

test('fork, Dependabot and retarget events use the trusted route', () => {
  assert.match(WORKFLOW, /permissions:[\s\S]*pull-requests:\s*write/);
  assert.match(WORKFLOW, /permissions:[\s\S]*issues:\s*write/);
  assert.match(WORKFLOW, /types:\s*\[[^\]]*edited[^\]]*\]/);
  assert.match(WORKFLOW, /schedule:/);
  assert.match(WORKFLOW, /cron:/);
});

test('the sweep paginates every open PR and fails when listing fails', () => {
  assert.match(WORKFLOW, /gh api --paginate/);
  assert.match(WORKFLOW, /pulls\?state=open&per_page=100/);
  assert.doesNotMatch(WORKFLOW, /--limit 500/);
  assert.match(WORKFLOW, /could not list open PRs[\s\S]*exit 1/);
});

test('the run is bound to the head and the base', () => {
  assert.match(SCRIPT, /after\.head !== before\.head \|\| after\.base !== before\.base/);
  assert.match(SCRIPT, /base: \.base\.sha/);
});

test('duplicate paths are collapsed and each hit names its rule', () => {
  const verdict = classifyPaths([
    'apps/operator-web/src/lib/square.ts',
    'apps/operator-web/src/lib/square.ts',
  ]);
  assert.equal(verdict.hits.length, 1);
  assert.equal(verdict.hits[0].rules.includes('money'), true);
  assert.match(verdict.hits[0].reason, /payments \/ money path/);
});

test('every rule has an id, reason and regex', () => {
  assert.ok(RULES.length > 0);
  for (const rule of RULES) {
    assert.match(rule.id, /^[a-z0-9-]+$/);
    assert.ok(rule.reason.length > 0);
    assert.ok(rule.re instanceof RegExp);
  }
});
