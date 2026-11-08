#!/usr/bin/env node
// Label a PR `needs-braden` from the paths it changes, at open time.
//
// Why: #716, #638 and #717 each lost a RED TEAM round to a missing label.
// This runs on pull_request_target (base-branch code only), before checks
// matter, and only ever ADDS the label. A human can still remove it.
//
// Rules learned the hard way:
//   1. Untrusted PR code must never run with a write token. The workflow
//      checks out the trusted base SHA and runs this file from there; PR head
//      code is never executed (#721 RED TEAM HIGH).
//   2. Read every page of the changed-file list and verify it against
//      `changed_files`. REST stops silently at 3,000 files, so a short list is
//      classified as needs-braden rather than trusted (#647, #721).
//   3. Check `previous_filename` too. A rename from a migration to a doc is
//      still a migration change.
//   4. Match CamelCase names like `RefundItemsSheet.tsx` and `MemberProForm`.
//      Splitting lower-to-upper boundaries keeps real money paths in scope.
//   5. Bind the decision to the head AND base. A base retarget changes the
//      diff without moving the head, so the caller re-runs and we refuse a
//      stale read.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LABEL = 'needs-braden';
const REST_FILE_CAP = 3000;

export const RULES = [
  { id: 'ci-gate', reason: 'CI, workflow or gate file', re: /^\.github\// },
  { id: 'gate-script', reason: 'ship-gate or labeler script', re: /^scripts\/(grok|ci)\// },
  { id: 'prod-rig', reason: 'production rig script', re: /^scripts\/prod-rig\// },
  { id: 'migration', reason: 'database migration', re: /(^|\/)(migrations?|migrate)\// },
  {
    id: 'money',
    reason: 'payments / money path',
    re: /(^|[\/._-])(money|payments?|refunds?|square|payouts?|checkout|settlements?|billing|subscriptions?|credits?|invoices?|tax)([\/._-]|$)/i,
  },
  { id: 'member-pro', reason: 'Member Pro path', re: /(^|[\/._-])member[-_. ]?pro([\/._-]|$)/i },
  { id: 'auth-rls', reason: 'auth or RLS path', re: /(^|[\/._-])(auth|rls)([\/._-]|$)/i },
  {
    id: 'deps',
    reason: 'dependency manifest or lockfile',
    re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  },
  {
    id: 'rules',
    reason: 'agent rule file',
    re: /(^|\/)(AGENTS|CLAUDE|MANAGER|WORKING_AGREEMENT|SCOPE)\.md$|^\.cursor\/rules\//i,
  },
  {
    id: 'state-rule',
    reason: 'maintained rule/state file',
    re: /^docs\/state\/(bots|redteam-findings)\.md$/i,
  },
  { id: 'prompt', reason: 'prompt file', re: /(^|\/)[^/]*\.prompt(\.[^/]+)?$/i },
  { id: 'coordination', reason: 'swarm coordination policy', re: /^coordination\// },
  { id: 'staff-ui', reason: 'staff app UI', re: /^apps\/field-mobile\/(app|features)\// },
];

// Accepts strings or GitHub file objects. A rename supplies both names.
export function changedPaths(files) {
  const out = [];
  for (const file of files ?? []) {
    if (typeof file === 'string') {
      out.push(file);
      continue;
    }
    if (!file) continue;
    if (file.filename) out.push(file.filename);
    if (file.previous_filename) out.push(file.previous_filename);
  }
  return [...new Set(out)];
}

// `lowerCase` → `lower-Case` and `HTTPServer` → `HTTP-Server`, so a rule with
// a boundary class sees `Refund-Items-Sheet` and `Member-Pro-Form`.
export function pathVariants(path) {
  if (typeof path !== 'string') return [];
  const split = path
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
  return split === path ? [path] : [path, split];
}

// `gh api --paginate --slurp` returns an array of pages. A single-page
// response is an array of file objects. Both are accepted.
export function collectChangedPaths(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return [];
  const flattened = Array.isArray(pages[0]) ? pages.flat() : pages;
  return changedPaths(flattened);
}

export function classifyPaths(files) {
  const paths = changedPaths(files);
  const hits = [];
  for (const path of paths) {
    for (const variant of pathVariants(path)) {
      for (const rule of RULES) {
        if (rule.re.test(variant)) hits.push({ path, rule: rule.id, reason: rule.reason });
      }
    }
  }
  const byPath = new Map();
  for (const hit of hits) {
    if (!byPath.has(hit.path)) byPath.set(hit.path, new Set());
    byPath.get(hit.path).add(hit.rule);
  }
  return {
    needsBraden: hits.length > 0,
    hits: [...byPath.entries()].map(([path, rules]) => ({
      path,
      rules: [...rules],
      reason: RULES.filter((r) => rules.has(r.id))
        .map((r) => r.reason)
        .join('; '),
    })),
  };
}

// Extract the file list and surface malformed pages instead of dropping them.
// `entries` counts file objects exactly as returned, so a rename (one object,
// two names) cannot inflate the completeness check (#721 RED TEAM).
//
// Entry filenames must be unique. Two records naming the same file mean the
// enumeration is inconsistent: the declared count could be satisfied by a
// duplicate while a real file is missing (#732). Detect that here so the
// completeness check below can trust `entries`.
export function collectFileList(pages) {
  if (!Array.isArray(pages)) {
    return { paths: [], entries: 0, problems: ['file list response is not an array'] };
  }
  if (pages.length === 0) return { paths: [], entries: 0, problems: [] };
  const flattened = Array.isArray(pages[0]) ? pages.flat() : pages;
  const problems = [];
  const seen = new Set();
  for (const entry of flattened) {
    if (!entry || typeof entry.filename !== 'string' || entry.filename.length === 0) {
      problems.push('file list has a malformed entry');
      continue;
    }
    if (seen.has(entry.filename)) {
      problems.push(`file list has a duplicate filename: ${entry.filename}`);
    }
    seen.add(entry.filename);
  }
  return { paths: changedPaths(flattened), entries: flattened.length, problems };
}

// Fail closed: if the file list cannot be proven complete, label the PR.
// A missing label costs a RED TEAM round; an extra label costs nothing.
export function classifyPrFiles({ pages, changedFiles }) {
  const { paths, entries, problems } = collectFileList(pages);
  const reasons = [...problems];
  const declared = Number.isFinite(changedFiles) ? changedFiles : null;
  if (declared === null) {
    reasons.push('changed_files metadata missing');
  } else if (declared > REST_FILE_CAP) {
    reasons.push(`file list exceeds REST cap (${declared} > ${REST_FILE_CAP})`);
  } else if (entries < declared) {
    reasons.push(`file list incomplete (${entries} of ${declared})`);
  } else if (entries > declared) {
    reasons.push(`file list has more entries than changed_files (${entries} > ${declared})`);
  }
  const verdict = classifyPaths(paths);
  if (reasons.length > 0) {
    return { needsBraden: true, incomplete: true, reasons, hits: verdict.hits };
  }
  return { needsBraden: verdict.needsBraden, incomplete: false, reasons: [], hits: verdict.hits };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function repoName() {
  return (
    process.env.GITHUB_REPOSITORY ||
    gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  );
}

function prMeta(repo, pr) {
  return JSON.parse(
    gh([
      'api',
      `repos/${repo}/pulls/${pr}`,
      '--jq',
      '{head: .head.sha, base: .base.sha, changedFiles: .changed_files}',
    ]),
  );
}

function prFilePages(repo, pr) {
  const raw = gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/files?per_page=100`]);
  return JSON.parse(raw || '[]');
}

function prLabels(repo, pr) {
  return JSON.parse(gh(['api', `repos/${repo}/issues/${pr}`, '--jq', '[.labels[].name]']));
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const pr = argv.find((arg) => !arg.startsWith('--'));
  if (!pr) {
    console.error('usage: needs-braden-label.mjs <pr-number> [--dry-run]');
    return 1;
  }

  const repo = repoName();
  const before = prMeta(repo, pr);
  const pages = prFilePages(repo, pr);
  const verdict = classifyPrFiles({ pages, changedFiles: before.changedFiles });
  const after = prMeta(repo, pr);

  // Refuse to label if the head or base moved while the file list was read.
  if (after.head !== before.head || after.base !== before.base) {
    console.log(`needs-braden: wait #${pr} (head or base moved)`);
    return 0;
  }

  if (!verdict.needsBraden) {
    console.log(`needs-braden: no #${pr}`);
    return 0;
  }

  const reasons = [...verdict.reasons];
  for (const hit of verdict.hits) reasons.push(`${hit.path} (${hit.reason})`);
  const detail = reasons.length > 0 ? `\n${reasons.join('\n')}` : '';

  if (prLabels(repo, pr).includes(LABEL)) {
    console.log(`needs-braden: already #${pr}${detail}`);
    return 0;
  }

  if (dryRun) {
    console.log(`needs-braden: would apply #${pr}${detail}`);
    return 0;
  }

  gh(['pr', 'edit', pr, '--add-label', LABEL, '--repo', repo]);
  // Surface a denied mutation instead of reporting success.
  if (!prLabels(repo, pr).includes(LABEL)) {
    throw new Error(`needs-braden: label not applied to #${pr}`);
  }
  console.log(`needs-braden: applied #${pr}${detail}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
