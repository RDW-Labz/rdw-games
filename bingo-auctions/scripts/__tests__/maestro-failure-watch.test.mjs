// #868: Maestro Smoke repeated-failure watch.
// Run: node --test scripts/__tests__/maestro-failure-watch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS_APP,
  ACTIONS_LOGIN,
  FAST_THRESHOLD,
  OPS_ISSUE,
  SLOW_THRESHOLD,
  TARGET_ISSUE,
  WATCH_BRANCH,
  evaluateRuns,
  hasMarker,
  marker,
  opsLine,
  processWatch,
  reminderBody,
} from '../ci/maestro-failure-watch.mjs';

const NOW = Date.parse('2026-11-06T05:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

let nextId = 1000;
function run({
  id,
  conclusion = 'failure',
  minutesAgo,
  branch = WATCH_BRANCH,
  status = 'completed',
  sha = 'abcdef0123456789abcdef0123456789abcdef01',
} = {}) {
  const runId = id ?? nextId++;
  return {
    id: runId,
    head_sha: sha,
    head_branch: branch,
    status,
    conclusion,
    created_at: at(minutesAgo),
    html_url: `https://github.com/RDW-Labz/bingo-auctions/actions/runs/${runId}`,
  };
}

const evaluate = (runs) => evaluateRuns({ runs, now: NOW });

test('two failures inside the fast window do not trip', () => {
  const verdict = evaluate([run({ id: 1, minutesAgo: 120 }), run({ id: 2, minutesAgo: 60 })]);
  assert.equal(verdict.tripped, false);
  assert.equal(verdict.reason, 'below-threshold');
  assert.deepEqual(verdict.counts, { sixHour: 2, day: 2 });
});

test('three failures inside the fast window trip', () => {
  const verdict = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ]);
  assert.equal(verdict.tripped, true);
  assert.equal(verdict.reason, 'fast-threshold');
  assert.deepEqual(verdict.counts, { sixHour: 3, day: 3 });
  assert.equal(verdict.streakId, 10);
});

test('five failures across the day trip the slow threshold', () => {
  const verdict = evaluate([
    run({ id: 1, minutesAgo: 20 * 60 }),
    run({ id: 2, minutesAgo: 16 * 60 }),
    run({ id: 3, minutesAgo: 12 * 60 }),
    run({ id: 4, minutesAgo: 8 * 60 }),
    run({ id: 5, minutesAgo: 4 * 60 }),
  ]);
  assert.equal(verdict.tripped, true);
  assert.equal(verdict.reason, 'day-threshold');
  assert.deepEqual(verdict.counts, { sixHour: 1, day: 5 });
});

test('three failures spread past six hours stay below both thresholds', () => {
  const verdict = evaluate([
    run({ id: 1, minutesAgo: 20 * 60 }),
    run({ id: 2, minutesAgo: 10 * 60 }),
    run({ id: 3, minutesAgo: 8 * 60 }),
  ]);
  assert.equal(verdict.tripped, false);
  assert.deepEqual(verdict.counts, { sixHour: 0, day: 3 });
});

test('a success resets the failure streak', () => {
  const before = evaluate([
    run({ id: 1, minutesAgo: 300 }),
    run({ id: 2, minutesAgo: 240 }),
    run({ id: 3, conclusion: 'success', minutesAgo: 180 }),
    run({ id: 4, minutesAgo: 120 }),
    run({ id: 5, minutesAgo: 60 }),
  ]);
  assert.equal(before.tripped, false);
  assert.deepEqual(before.counts, { sixHour: 2, day: 2 });

  const after = evaluate([
    run({ id: 1, minutesAgo: 300 }),
    run({ id: 2, minutesAgo: 240 }),
    run({ id: 3, conclusion: 'success', minutesAgo: 180 }),
    run({ id: 4, minutesAgo: 120 }),
    run({ id: 5, minutesAgo: 60 }),
    run({ id: 6, minutesAgo: 30 }),
  ]);
  assert.equal(after.tripped, true);
  assert.deepEqual(after.counts, { sixHour: 3, day: 3 });
  assert.equal(after.streakId, 4);
});

test('failures on other branches are ignored', () => {
  const verdict = evaluate([
    run({ id: 1, minutesAgo: 200, branch: 'feature/x' }),
    run({ id: 2, minutesAgo: 100, branch: 'feature/x' }),
    run({ id: 3, minutesAgo: 60, branch: 'feature/x' }),
  ]);
  assert.equal(verdict.tripped, false);
  assert.deepEqual(verdict.counts, { sixHour: 0, day: 0 });
});

test('a success on another branch does not reset the master streak', () => {
  const verdict = evaluate([
    run({ id: 1, minutesAgo: 300 }),
    run({ id: 2, minutesAgo: 240 }),
    run({ id: 3, minutesAgo: 180 }),
    run({ id: 4, conclusion: 'success', minutesAgo: 120, branch: 'feature/x' }),
  ]);
  assert.equal(verdict.tripped, true);
  assert.deepEqual(verdict.counts, { sixHour: 3, day: 3 });
});

test('cancelled and skipped runs do not count; timed_out does', () => {
  const verdict = evaluate([
    run({ id: 1, conclusion: 'cancelled', minutesAgo: 200 }),
    run({ id: 2, conclusion: 'skipped', minutesAgo: 150 }),
    run({ id: 3, conclusion: 'timed_out', minutesAgo: 100 }),
  ]);
  assert.equal(verdict.tripped, false);
  assert.deepEqual(verdict.counts, { sixHour: 1, day: 1 });
});

test('incomplete and future runs are ignored', () => {
  const verdict = evaluate([
    run({ id: 1, status: 'in_progress', conclusion: '', minutesAgo: 60 }),
    run({ id: 2, status: 'queued', conclusion: '', minutesAgo: 30 }),
    run({ id: 3, minutesAgo: -10 }),
  ]);
  assert.equal(verdict.tripped, false);
  assert.deepEqual(verdict.counts, { sixHour: 0, day: 0 });
});

test('the streak id stays stable when a newer failure arrives', () => {
  const first = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ]);
  const second = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
    run({ id: 9, minutesAgo: 10 }),
  ]);
  assert.equal(second.tripped, true);
  assert.equal(second.streakId, first.streakId);
});

test('only trusted authors can suppress an alert with a marker', () => {
  assert.equal(hasMarker([{ app: 0, user: 'stranger', body: marker(10) }], 10), false);
  assert.equal(hasMarker([{ app: 0, user: ACTIONS_LOGIN, body: marker(10) }], 10), true);
  assert.equal(hasMarker([{ app: ACTIONS_APP, user: 'x', body: marker(10) }], 10), true);
  assert.equal(hasMarker([{ app: ACTIONS_APP, user: 'x', body: marker(99) }], 10), false);
  assert.equal(hasMarker([{ app: ACTIONS_APP, user: 'x', body: 'no marker' }], 10), false);
});

test('a failure streak alerts once on #519 and once on #687', () => {
  const verdict = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ]);
  const store = new Map([
    [TARGET_ISSUE, []],
    [OPS_ISSUE, []],
  ]);
  const calls = [];
  const deps = {
    readComments: (issue) => store.get(issue) ?? [],
    postComment: (issue, body) => {
      calls.push({ issue, body });
      store.get(issue).push({ app: ACTIONS_APP, user: ACTIONS_LOGIN, body });
    },
  };

  const first = processWatch({ verdict, ...deps });
  assert.deepEqual(
    first.row.posted.sort((a, b) => a - b),
    [TARGET_ISSUE, OPS_ISSUE],
  );
  assert.equal(calls.filter((call) => call.issue === TARGET_ISSUE).length, 1);
  assert.equal(calls.filter((call) => call.issue === OPS_ISSUE).length, 1);

  const second = processWatch({ verdict, ...deps });
  assert.deepEqual(second.row.posted, []);
  assert.deepEqual(
    second.row.alreadyNotified.sort((a, b) => a - b),
    [TARGET_ISSUE, OPS_ISSUE],
  );
  assert.equal(calls.length, 2, 'a repeat run inside the same streak must not post again');
});

test('a later run in the same streak does not post again', () => {
  const firstRunSet = [
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ];
  const store = new Map([
    [TARGET_ISSUE, []],
    [OPS_ISSUE, []],
  ]);
  let posts = 0;
  const deps = {
    readComments: (issue) => store.get(issue) ?? [],
    postComment: (issue, body) => {
      posts++;
      store.get(issue).push({ app: ACTIONS_APP, user: ACTIONS_LOGIN, body });
    },
  };

  processWatch({ verdict: evaluate(firstRunSet), ...deps });
  assert.equal(posts, 2);

  const grown = evaluate([...firstRunSet, run({ id: 13, minutesAgo: 20 })]);
  const { row } = processWatch({ verdict: grown, ...deps });
  assert.deepEqual(row.posted, []);
  assert.deepEqual(
    row.alreadyNotified.sort((a, b) => a - b),
    [TARGET_ISSUE, OPS_ISSUE],
  );
  assert.equal(posts, 2);
});

test('a dry run reports both targets and writes nothing', () => {
  const verdict = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ]);
  const { row } = processWatch({
    verdict,
    readComments: () => [],
    postComment: () => {
      throw new Error('must not post in a dry run');
    },
    dryRun: true,
  });
  assert.deepEqual(row.posted, []);
  assert.equal(row.wouldPost.length, 2);
  assert.deepEqual(
    row.wouldPost.map((entry) => entry.issue).sort((a, b) => a - b),
    [TARGET_ISSUE, OPS_ISSUE],
  );
});

test('one unreadable issue does not stop the other alert', () => {
  const verdict = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ]);
  const calls = [];
  const { row } = processWatch({
    verdict,
    readComments: (issue) => {
      if (issue === TARGET_ISSUE) throw new Error('boom');
      return [];
    },
    postComment: (issue, body) => calls.push({ issue, body }),
  });
  assert.deepEqual(row.posted, [OPS_ISSUE]);
  assert.equal(row.failed.length, 1);
  assert.equal(row.failed[0].issue, TARGET_ISSUE);
});

test('reminder bodies carry run links and no log text', () => {
  const verdict = evaluate([
    run({ id: 10, minutesAgo: 300 }),
    run({ id: 11, minutesAgo: 200 }),
    run({ id: 12, minutesAgo: 100 }),
  ]);
  const body = reminderBody({ verdict });
  assert.match(body, /actions\/runs\/10/);
  assert.match(body, /actions\/runs\/12/);
  assert.ok(body.includes(marker(verdict.streakId)));
  assert.match(body, /read-only reminder/);
  assert.match(body, new RegExp(`#${TARGET_ISSUE}`));

  const line = opsLine({ verdict });
  assert.equal(line.includes('\n'), false);
  assert.match(line, /actions\/runs/);
  assert.ok(line.includes(marker(verdict.streakId)));
});

test('thresholds are the documented values', () => {
  assert.equal(FAST_THRESHOLD, 3);
  assert.equal(SLOW_THRESHOLD, 5);
  assert.equal(TARGET_ISSUE, 519);
  assert.equal(OPS_ISSUE, 687);
  assert.equal(WATCH_BRANCH, 'master');
});
