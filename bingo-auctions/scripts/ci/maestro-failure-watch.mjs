#!/usr/bin/env node
// #868: Maestro Smoke has failed repeatedly on master, night after night,
// without anyone noticing (#519 was opened for the underlying emulator/sign-in
// bug but the failures themselves were silent).
//
// This watcher reads completed "Maestro Smoke" runs on master and, when the
// current failure streak crosses a threshold, posts exactly ONE reminder on
// #519 and ONE line on #687. The failure streak is reset by a success, so a
// single bad night alerts once instead of once per run.
//
// It is monitoring only:
//   - it never labels, approves, merges or closes anything;
//   - it never weakens or skips a check;
//   - its only writes are two issue comments, guarded by an idempotency marker;
//   - every value in a comment comes from the Actions API (run id, head SHA,
//     timestamps, links), never from logs, secrets or customer data.
//
// Usage:
//   node scripts/ci/maestro-failure-watch.mjs [--dry-run] [--repo owner/name]
//                                            [--now 2026-11-06T05:00:00Z]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = 'RDW-Labz/bingo-auctions';
export const MAESTRO_WORKFLOW = 'maestro.yml';
export const WATCH_BRANCH = 'master';

export const FAST_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SLOW_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FAST_THRESHOLD = 3;
export const SLOW_THRESHOLD = 5;

// #519 is the underlying emulator/sign-in fix. #687 is the daily ops digest
// where a one-line "this is still red" signal is visible to the owner.
export const TARGET_ISSUE = 519;
export const OPS_ISSUE = 687;

// The workflow posts with GITHUB_TOKEN, which appears as the Actions bot user
// (and sometimes as the Actions app). Only those authors' markers count, so a
// stranger cannot suppress the alert by pasting the marker text.
export const ACTIONS_APP = 15368;
export const ACTIONS_LOGIN = 'github-actions[bot]';
export const MARKER_PREFIX = 'maestro-failure-watch';

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out']);

export function isFailureRun(run) {
  return Boolean(run) && FAILURE_CONCLUSIONS.has(String(run.conclusion ?? '').toLowerCase());
}

export function isSuccessRun(run) {
  return Boolean(run) && String(run.conclusion ?? '').toLowerCase() === 'success';
}

function completedAt(run) {
  const ms = Date.parse(run?.created_at ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function marker(streakId) {
  return `<!-- ${MARKER_PREFIX}:streak=${streakId} -->`;
}

export function isTrustedMarkerComment(comment) {
  if (!comment || String(comment.body ?? '').indexOf(MARKER_PREFIX) < 0) return false;
  return comment.app === ACTIONS_APP || comment.user === ACTIONS_LOGIN;
}

// A marker names one failure streak, so a later run inside the same streak is
// "already-notified" and does not post again.
export function hasMarker(comments, streakId) {
  if (streakId == null) return false;
  const needle = marker(streakId);
  return (comments ?? []).some(
    (comment) => isTrustedMarkerComment(comment) && String(comment.body ?? '').includes(needle),
  );
}

function summable(run, now, branch) {
  if (!run || run.status !== 'completed') return false;
  if (String(run.head_branch ?? '') !== branch) return false;
  const at = completedAt(run);
  return at != null && at <= now;
}

export function evaluateRuns({ runs = [], now = Date.now(), branch = WATCH_BRANCH }) {
  const eligible = runs
    .filter((run) => summable(run, now, branch))
    .sort((a, b) => completedAt(b) - completedAt(a));

  // A success ends the streak: failures older than the newest success are no
  // longer evidence of a current outage.
  const latestSuccess = eligible.find(isSuccessRun);
  const streakStart = latestSuccess ? completedAt(latestSuccess) : -Infinity;
  const streak = eligible.filter((run) => isFailureRun(run) && completedAt(run) > streakStart);

  const sixHour = streak.filter((run) => completedAt(run) >= now - FAST_WINDOW_MS);
  const day = streak.filter((run) => completedAt(run) >= now - SLOW_WINDOW_MS);
  const tripped = sixHour.length >= FAST_THRESHOLD || day.length >= SLOW_THRESHOLD;

  let reason = 'below-threshold';
  if (tripped) reason = sixHour.length >= FAST_THRESHOLD ? 'fast-threshold' : 'day-threshold';

  return {
    branch,
    tripped,
    reason,
    counts: { sixHour: sixHour.length, day: day.length },
    thresholds: { sixHour: FAST_THRESHOLD, day: SLOW_THRESHOLD },
    // The oldest failure in the streak keeps the marker stable while newer
    // failures arrive, so a chronic streak alerts once rather than per run.
    streakId:
      streak.length > 0
        ? (streak[streak.length - 1].id ?? streak[streak.length - 1].head_sha ?? null)
        : null,
    failures: day.map((run) => ({
      id: run.id ?? null,
      headSha: String(run.head_sha ?? ''),
      createdAt: String(run.created_at ?? ''),
      url: String(run.html_url ?? ''),
    })),
  };
}

function shortSha(sha) {
  return String(sha || '').slice(0, 8) || 'unknown';
}

export function reminderBody({ verdict }) {
  const { counts, thresholds, failures } = verdict;
  const lines = [];
  lines.push(
    `Maestro Smoke is failing repeatedly on \`${WATCH_BRANCH}\`: **${counts.sixHour} failure(s) in the last 6h**, ${counts.day} in the last 24h (auto-alert fires at ${thresholds.sixHour}/6h or ${thresholds.day}/24h).`,
  );
  lines.push('');
  lines.push('Recent failed runs:');
  for (const run of failures.slice(0, 10)) {
    lines.push(`- \`${shortSha(run.headSha)}\` ${run.createdAt}${run.url ? ` — ${run.url}` : ''}`);
  }
  if (failures.length > 10) lines.push(`- …and ${failures.length - 10} more in the last 24h.`);
  lines.push('');
  lines.push(
    `This is the failure streak that #${TARGET_ISSUE} tracks. It is a read-only reminder: it does not change labels, approve, merge or weaken any check.`,
  );
  lines.push('');
  lines.push(marker(verdict.streakId));
  return lines.join('\n');
}

export function opsLine({ verdict, repo = REPO }) {
  const { counts, thresholds, failures } = verdict;
  const links = failures
    .slice(0, 3)
    .map((failure) => failure.url)
    .filter(Boolean)
    .join(' ');
  return [
    `[Maestro] ${counts.day} failed run(s) on \`${WATCH_BRANCH}\` in 24h`,
    `(${counts.sixHour} in 6h; alert at ${thresholds.sixHour}/6h or ${thresholds.day}/24h).`,
    `Tracking: https://github.com/${repo}/issues/${TARGET_ISSUE}.`,
    links ? `Recent: ${links}` : '',
    marker(verdict.streakId),
  ]
    .filter(Boolean)
    .join(' ');
}

export function processWatch({ verdict, readComments, postComment, dryRun = false }) {
  const row = {
    branch: verdict.branch,
    tripped: verdict.tripped,
    reason: verdict.reason,
    counts: verdict.counts,
    streakId: verdict.streakId,
    posted: [],
    wouldPost: [],
    alreadyNotified: [],
    failed: [],
  };
  if (!verdict.tripped) return { row };

  const targets = [
    { issue: TARGET_ISSUE, body: reminderBody({ verdict }) },
    { issue: OPS_ISSUE, body: opsLine({ verdict }) },
  ];

  for (const target of targets) {
    let comments;
    try {
      comments = readComments(target.issue);
    } catch (error) {
      row.failed.push({ issue: target.issue, error: String(error?.message || error) });
      continue;
    }
    if (hasMarker(comments, verdict.streakId)) {
      row.alreadyNotified.push(target.issue);
      continue;
    }
    if (dryRun) {
      row.wouldPost.push({ issue: target.issue, body: target.body });
      continue;
    }
    try {
      postComment(target.issue, target.body);
      row.posted.push(target.issue);
    } catch (error) {
      row.failed.push({ issue: target.issue, error: String(error?.message || error) });
    }
  }

  return { row };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function listRuns(repo) {
  const raw = gh([
    'api',
    `repos/${repo}/actions/workflows/${MAESTRO_WORKFLOW}/runs?per_page=100&branch=${WATCH_BRANCH}`,
    '--jq',
    '.workflow_runs[] | [.id, (.head_sha // ""), (.head_branch // ""), (.status // ""), (.conclusion // ""), (.created_at // ""), (.html_url // "")] | @tsv',
  ]);
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, head_sha, head_branch, status, conclusion, created_at, html_url] =
        line.split('\t');
      return {
        id: Number(id),
        head_sha,
        head_branch,
        status,
        conclusion,
        created_at,
        html_url,
      };
    });
}

function listComments(repo, issue) {
  const raw = gh([
    'api',
    `repos/${repo}/issues/${issue}/comments?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | [(.performed_via_github_app.id // 0), (.user.login // ""), (.body | @base64)] | @tsv',
  ]);
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [app, user, body] = line.split('\t');
      return {
        app: Number(app),
        user,
        body: Buffer.from(body, 'base64').toString('utf8'),
      };
    });
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    now: Date.now(),
    repo: process.env.GITHUB_REPOSITORY || REPO,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--now') args.now = Date.parse(argv[++i]);
    else if (arg.startsWith('--now=')) args.now = Date.parse(arg.split('=')[1]);
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg.startsWith('--repo=')) args.repo = arg.split('=')[1];
  }
  if (!Number.isFinite(args.now)) args.now = Date.now();
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = listRuns(args.repo);
  const verdict = evaluateRuns({ runs, now: args.now });
  const { row } = processWatch({
    verdict,
    readComments: (issue) => listComments(args.repo, issue),
    postComment: (issue, body) =>
      gh(['issue', 'comment', String(issue), '--repo', args.repo, '--body', body]),
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify({ dryRun: args.dryRun, ...row }, null, 2));
  if (row.failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
