// #723: stalled RED TEAM re-review notices.
// Run: node --test scripts/__tests__/stalled-review-alert.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROK_APP,
  RED_TEAM_APP,
  STALL_MS,
  checkedHead,
  evaluatePullRequest,
  headStillValid,
  isRequestComment,
  isSameHeadRequest,
  isTrustedAuthor,
  isVerdictComment,
  marker,
  maskHistory,
  maskInertText,
  mentionsHead,
  prReadOutcome,
  processPullRequest,
  reminderBody,
  shaTokens,
  sweepPullRequests,
  verdictKind,
} from '../grok/stalled-review-alert.mjs';

const HEAD = '9bb9bd11aabbccddeeff00112233445566778899';
const SHORT = HEAD.slice(0, 8);
const OLD = 'e0be5ea0489958418fdfbce0fcefd5d3d39cb83e';
const T = '2026-11-05T05:00:00Z';
const T_PLUS_59 = Date.parse(T) + 59 * 60_000;
const T_PLUS_61 = Date.parse(T) + 61 * 60_000;
const T_PLUS_122 = Date.parse(T) + 122 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

const request = (at = T, head = SHORT, app = 0, user = 'btabor11') => ({
  at,
  app,
  user,
  url: 'https://github.com/RDW-Labz/bingo-auctions/pull/795#issuecomment-1',
  body: `RED TEAM re-review requested on \`${head}\` — all checks green on this head.`,
});

const verdict = (at = T, head = HEAD, app = RED_TEAM_APP, text = 'FAIL') => ({
  at,
  app,
  url: 'https://github.com/RDW-Labz/bingo-auctions/pull/795#issuecomment-2',
  body: `[RED TEAM]\nVERDICT: ${text} — BLOCK\nCommit checked: ${head}\n\nOne finding.`,
});

const evaluate = (comments, now = T_PLUS_61, stallMs = STALL_MS) =>
  evaluatePullRequest({ head: HEAD, comments, now, stallMs });

test('a request with no verdict after 60 minutes is flagged', () => {
  const result = evaluate([request()]);
  assert.equal(result.stalled, true);
  assert.equal(result.alreadyNotified, false);
  assert.equal(result.reason, 'stalled');
  assert.ok(result.ageMs >= 60 * 60_000);
});

test('a request under 60 minutes is not flagged', () => {
  const result = evaluate([request()], T_PLUS_59);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'too-recent');
});

test('a verdict on the current head suppresses the flag', () => {
  const result = evaluate([request(), verdict()]);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'verdict-present');
});

test('a verdict only on an older head does not suppress the flag', () => {
  const result = evaluate([request(T, OLD), request(), verdict(T, OLD)]);
  assert.equal(result.stalled, true);
});

test('verdict-looking text from any other account is ignored', () => {
  const fake = verdict(T, HEAD, 999);
  assert.equal(isVerdictComment(fake, HEAD), false);
  assert.equal(evaluate([request(), fake]).stalled, true);
});

test('the flag is posted once per head', () => {
  const posted = {
    at: T_PLUS_61,
    app: 0,
    user: 'github-actions[bot]',
    body: reminderBody({
      head: HEAD,
      short: SHORT,
      ageMs: 61 * 60_000,
      requestAt: T,
      requestUrl: null,
    }),
  };
  const second = evaluate([request(), posted], T_PLUS_122);
  assert.equal(second.stalled, true);
  assert.equal(second.alreadyNotified, true);
  assert.equal(second.reason, 'already-notified');
  // The reminder itself must not count as a fresh re-review request.
  assert.equal(isRequestComment(posted), false);
});

test('a moved head has no request until the new head is requested', () => {
  const moved = evaluatePullRequest({
    head: HEAD,
    comments: [request(T, OLD), verdict(T, OLD)],
    now: T_PLUS_61,
  });
  assert.equal(moved.stalled, false);
  assert.equal(moved.reason, 'no-request-for-head');

  const requestedNew = evaluatePullRequest({
    head: HEAD,
    comments: [request(T, OLD), request(T, SHORT), verdict(T, OLD)],
    now: T_PLUS_61,
  });
  assert.equal(requestedNew.stalled, true);
  assert.equal(requestedNew.requestAt, T);
});

test('no request at all is not flagged', () => {
  const result = evaluate([verdict()]);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'no-request-for-head');
});

test('a request that does not name the head is not flagged', () => {
  const result = evaluate([request(T, OLD)]);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'no-request-for-head');
});

test('a Grok request counts, but staff text does not', () => {
  const grok = request(T, SHORT, GROK_APP);
  assert.equal(isRequestComment(grok), true);
  assert.equal(evaluate([grok]).stalled, true);

  const staff = request(T, SHORT, 777);
  assert.equal(isRequestComment(staff), false);
  assert.equal(evaluate([staff]).stalled, false);
});

test('short and full SHAs match in both directions', () => {
  assert.equal(mentionsHead(`head \`${SHORT}\``, HEAD), true);
  assert.equal(mentionsHead(`Commit checked: ${HEAD}`, SHORT), true);
  assert.equal(mentionsHead('nothing here', HEAD), false);
  assert.deepEqual([...shaTokens(`a ${SHORT} b ${HEAD}`)], [SHORT, HEAD]);
});

test('the reminder is read-only and never reads as a verdict', () => {
  const body = reminderBody({
    head: HEAD,
    short: SHORT,
    ageMs: 61 * 60_000,
    requestAt: T,
    requestUrl: 'https://example.test/c',
  });
  assert.match(body, /no verdict for 61 minutes/);
  assert.match(body, /read-only reminder, not a verdict/);
  assert.ok(body.includes(marker(HEAD)));
  assert.doesNotMatch(body, /VERDICT:\s*(PASS|FAIL|BLOCK|FREEZE|NO-GO|GO)\b/i);
  assert.equal(isVerdictComment({ at: T, app: 0, body }, HEAD), false);
});

test('reminders are bound to one head and do not leak across heads', () => {
  const first = { at: T_PLUS_61, app: 0, user: 'github-actions[bot]', body: marker(HEAD) };
  const result = evaluate([request(T, OLD), request(), first], T_PLUS_122);
  assert.equal(result.alreadyNotified, true);
  const other = evaluatePullRequest({
    head: OLD,
    comments: [request(T, OLD), first],
    now: T_PLUS_122,
  });
  assert.equal(other.alreadyNotified, false);
});

// #809 (MEDIUM 1): verdict chronology, not mere presence, answers a request.
test('a verdict before a later same-head recheck does not suppress the alert', () => {
  const requestAt = Date.parse(T) + 10 * 60_000;
  const result = evaluate(
    [verdict(T, HEAD), request(iso(requestAt), SHORT)],
    requestAt + 61 * 60_000,
  );
  assert.equal(result.stalled, true);
  assert.equal(result.alreadyNotified, false);
  assert.equal(result.requestAt, iso(requestAt));
});

test('a verdict at or after the latest request still suppresses the alert', () => {
  const verdictAt = Date.parse(T) + 10 * 60_000;
  const result = evaluate([request(T, SHORT), verdict(iso(verdictAt), HEAD)], T_PLUS_122);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'verdict-present');
});

// #809 (MEDIUM 2): the actual recheck wording from #716 / #638 is recognized,
// while ordinary discussion is not.
test('actual recheck wording is recognized and ordinary discussion is not', () => {
  const recheck = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `\`needs-braden\` is now applied. Requesting a RED TEAM re-check on the same head \`${SHORT}\`. No code changed.`,
  };
  assert.equal(isRequestComment(recheck), true);
  assert.equal(evaluate([recheck]).stalled, true);

  const discussion = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: 'The idle review note is still on the board and nobody has picked it up.',
  };
  assert.equal(isRequestComment(discussion), false);
  assert.equal(evaluate([discussion]).stalled, false);
});

// #809 (MEDIUM 3): an incidental mention of the head is not a checked verdict.
test('a verdict only mentioning the head incidentally does not suppress', () => {
  const incidental = {
    at: T,
    app: RED_TEAM_APP,
    body: `[RED TEAM]\nVERDICT: PASS\nCommit checked: ${OLD}\n\nThis supersedes the earlier review of ${HEAD}.`,
  };
  assert.equal(checkedHead(incidental.body), OLD);
  assert.equal(isVerdictComment(incidental, HEAD), false);
  assert.equal(evaluate([request(), incidental]).stalled, true);

  const noField = {
    at: T,
    app: RED_TEAM_APP,
    body: `[RED TEAM]\nVERDICT: PASS\n\nLooks fine on ${HEAD}.`,
  };
  assert.equal(checkedHead(noField.body), null);
  assert.equal(isVerdictComment(noField, HEAD), false);
});

test('the authoritative checked commit is parsed in its common forms', () => {
  assert.equal(checkedHead(`Commit checked: ${HEAD}`), HEAD);
  assert.equal(checkedHead(`**Commit checked:** \`${SHORT}\``), SHORT);
  assert.equal(checkedHead('Commit checked: not-a-sha'), null);
});

// #809 (MEDIUM 4): pre-write validation rejects a moved, closed or merged PR.
test('pre-write validation rejects a moved, closed or merged PR', () => {
  assert.equal(headStillValid(HEAD, { state: 'OPEN', headRefOid: HEAD }), true);
  assert.equal(headStillValid(HEAD, { state: 'OPEN', headRefOid: OLD }), false);
  assert.equal(headStillValid(HEAD, { state: 'CLOSED', headRefOid: HEAD }), false);
  assert.equal(headStillValid(HEAD, { state: 'MERGED', headRefOid: HEAD }), false);
  assert.equal(headStillValid(HEAD, null), false);
});

// #809 (MEDIUM 5): only trusted identities can reset or suppress the alert.
test('untrusted requests cannot reset the alert', () => {
  const stranger = request(T, SHORT, 0, 'random-user');
  assert.equal(isTrustedAuthor(stranger), false);
  assert.equal(isRequestComment(stranger), false);
  assert.equal(evaluate([stranger]).stalled, false);

  const strangerApp = request(T, SHORT, 999);
  assert.equal(isRequestComment(strangerApp), false);
});

test('untrusted markers cannot suppress the alert, workflow markers dedupe', () => {
  const stranger = { at: T_PLUS_61, app: 0, user: 'random-user', body: marker(HEAD) };
  const suppressed = evaluate([request(), stranger], T_PLUS_122);
  assert.equal(suppressed.stalled, true);
  assert.equal(suppressed.alreadyNotified, false);

  const workflow = { at: T_PLUS_61, app: 0, user: 'github-actions[bot]', body: marker(HEAD) };
  const deduped = evaluate([request(), workflow], T_PLUS_122);
  assert.equal(deduped.stalled, true);
  assert.equal(deduped.alreadyNotified, true);
  assert.equal(deduped.reason, 'already-notified');
});

// #828: the #827 alert findings are folded into this suite.
test('genuine Actions comments dedupe and can request; foreign apps stay untrusted', () => {
  const actionsMarker = {
    at: T_PLUS_61,
    app: 15368,
    user: 'github-actions[bot]',
    body: marker(HEAD),
  };
  assert.equal(isTrustedAuthor(actionsMarker), true);
  const deduped = evaluate([request(), actionsMarker], T_PLUS_122);
  assert.equal(deduped.alreadyNotified, true);

  const actionsRequest = {
    at: T,
    app: 15368,
    user: 'github-actions[bot]',
    body: `re-review requested on \`${SHORT}\` — checks green.`,
  };
  assert.equal(isRequestComment(actionsRequest), true);

  assert.equal(isTrustedAuthor({ app: 999, user: 'github-actions[bot]' }), false);
  assert.equal(isTrustedAuthor({ app: 15368, user: 'someone-else' }), false);
});

test('quoted and fenced checked-commit history cannot establish verdict scope', () => {
  const body = [
    '[RED TEAM]',
    'VERDICT: PASS',
    '',
    `> Commit checked: ${OLD}`,
    '',
    '```',
    `Commit checked: ${OLD}`,
    '```',
    '',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(checkedHead(body), HEAD);

  const onlyQuoted = [`> Commit checked: ${OLD}`, '```', `Commit checked: ${OLD}`, '```'].join(
    '\n',
  );
  assert.equal(checkedHead(onlyQuoted), null);

  assert.equal(checkedHead(`Commit checked: ${HEAD}\nCommit checked: ${OLD}`), null);
  assert.equal(checkedHead(`Commit checked: ${HEAD}\nCommit checked: ${HEAD}`), HEAD);
});

test('a verdict quoted as history does not suppress the current head', () => {
  const quoted = {
    at: T,
    app: RED_TEAM_APP,
    url: 'https://example.test/c',
    body: [
      '[RED TEAM]',
      'VERDICT: PASS',
      `Commit checked: ${OLD}`,
      '',
      `> VERDICT: PASS`,
      `> Commit checked: ${HEAD}`,
    ].join('\n'),
  };
  assert.equal(verdictKind(quoted.body), 'PASS');
  assert.equal(isVerdictComment(quoted, HEAD), false);
  assert.equal(evaluate([request(), quoted]).stalled, true);
});

test('negated or explanatory re-check wording neither creates nor resets a request', () => {
  const negated = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `No RED TEAM re-check is needed on \`${SHORT}\`; the head did not move.`,
  };
  assert.equal(isRequestComment(negated), false);
  assert.equal(evaluate([negated]).stalled, false);

  const notRequest = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `There is not a RED TEAM re-review request on \`${SHORT}\` yet.`,
  };
  assert.equal(isRequestComment(notRequest), false);

  const quoted = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `The old note said "RED TEAM re-review requested on ${SHORT}" but nobody asked again.`,
  };
  assert.equal(isRequestComment(quoted), false);

  const genuine = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `No code changed. Requesting a RED TEAM re-check on the same head \`${SHORT}\`.`,
  };
  assert.equal(isRequestComment(genuine), true);
});

test('a request for the new head means the PR is waiting on a push (#711)', () => {
  const fail = verdict(T, HEAD, RED_TEAM_APP, 'FAIL');
  const relay = {
    at: iso(Date.parse(T) + 5 * 60_000),
    app: GROK_APP,
    user: 'Btabor11',
    url: 'https://example.test/c',
    body: `RED TEAM BLOCK/FAIL recorded at ${HEAD}. Standing rule: fix every finding, push, and ask RED TEAM to re-review the new head. Repeat until VERDICT: PASS on the current head.`,
  };
  const result = evaluate([fail, relay], T_PLUS_122);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'awaiting-push');

  // The same-head recheck is genuinely pending (#716/#638/#717).
  const recheck = {
    at: iso(Date.parse(T) + 5 * 60_000),
    app: 0,
    user: 'btabor11',
    url: 'https://example.test/c',
    body: `\`needs-braden\` is now applied. Requesting a RED TEAM re-check on the same head \`${SHORT}\`. No code changed in this tick.`,
  };
  const pending = evaluate([fail, recheck], T_PLUS_122);
  assert.equal(pending.stalled, true);
  assert.equal(pending.mode, 'recheck');
  assert.equal(pending.reason, 'stalled-since-recheck');
  assert.equal(pending.priorVerdict.kind, 'FAIL');
  assert.equal(pending.requestAt, recheck.at);

  const body = reminderBody({
    head: HEAD,
    short: SHORT,
    ageMs: pending.ageMs,
    requestAt: pending.requestAt,
    requestUrl: pending.requestUrl,
    mode: pending.mode,
    priorVerdict: pending.priorVerdict,
  });
  assert.match(body, /no new verdict for \d+ minutes/);
  assert.match(body, /last verdict on this head was \*\*FAIL\*\*/);
  assert.doesNotMatch(body, /VERDICT:\s*(PASS|FAIL|BLOCK|FREEZE|NO-GO|GO)\b/i);
  assert.ok(body.includes(marker(HEAD)));
});

test('a verdict on the current head with no pending request stays quiet', () => {
  const fail = verdict(T, HEAD, RED_TEAM_APP, 'FAIL');
  const result = evaluate([request(iso(Date.parse(T) - 5 * 60_000), SHORT), fail], T_PLUS_122);
  assert.equal(result.stalled, false);
  assert.equal(result.reason, 'verdict-present');
});

test('transport failures are not mistaken for a missing PR', () => {
  assert.equal(prReadOutcome({ ok: true }), 'ok');
  assert.equal(
    prReadOutcome({ ok: false, stderr: 'Could not resolve to a PullRequest' }),
    'missing',
  );
  assert.equal(prReadOutcome({ ok: false, stderr: 'HTTP 502: Bad Gateway' }), 'error');
  assert.equal(prReadOutcome({ ok: false, stderr: 'rate limit exceeded' }), 'error');
});

// #828 (RED TEAM #827 MEDIUM 4): push, close and merge during the final
// comment read must never produce a stale write.
const baseSweep = {
  readComments: () => [request()],
  now: T_PLUS_122,
  stallMs: STALL_MS,
  dryRun: false,
};

test('a push during the final comment read blocks the stale reminder', () => {
  let views = 0;
  const posted = [];
  const { row } = processPullRequest({
    ...baseSweep,
    pr: { number: 900, headRefOid: HEAD },
    readPr: () =>
      ++views === 1 ? { state: 'OPEN', headRefOid: HEAD } : { state: 'OPEN', headRefOid: OLD },
    postComment: (number, body) => posted.push({ number, body }),
  });
  assert.equal(posted.length, 0);
  assert.equal(row.posted, false);
  assert.equal(row.reason, 'head-moved');
});

test('a close or merge during the final comment read blocks the stale reminder', () => {
  for (const state of ['CLOSED', 'MERGED']) {
    let views = 0;
    const posted = [];
    const { row } = processPullRequest({
      ...baseSweep,
      pr: { number: 901, headRefOid: HEAD },
      readPr: () =>
        ++views === 1 ? { state: 'OPEN', headRefOid: HEAD } : { state, headRefOid: HEAD },
      postComment: (number, body) => posted.push({ number, body }),
    });
    assert.equal(posted.length, 0, state);
    assert.equal(row.posted, false, state);
    assert.equal(row.reason, 'closed', state);
  }
});

test('a normal stalled PR posts once after both revalidations', () => {
  const posted = [];
  const { row } = processPullRequest({
    ...baseSweep,
    pr: { number: 902, headRefOid: HEAD },
    readPr: () => ({ state: 'OPEN', headRefOid: HEAD }),
    postComment: (number, body) => posted.push({ number, body }),
  });
  assert.equal(posted.length, 1);
  assert.equal(row.posted, true);
  assert.ok(posted[0].body.includes(marker(HEAD)));
});

test('a transport failure fails that PR but the sweep continues', () => {
  const posted = [];
  const { failures, candidates } = sweepPullRequests({
    ...baseSweep,
    prs: [
      { number: 903, headRefOid: HEAD },
      { number: 904, headRefOid: HEAD },
    ],
    readPr: (number) => {
      if (number === 903) throw new Error('HTTP 502 Bad Gateway');
      return { state: 'OPEN', headRefOid: HEAD };
    },
    postComment: (number) => posted.push(number),
  });
  assert.equal(failures, 1);
  assert.deepEqual(posted, [904]);
  assert.match(candidates[0].error, /502/);
  assert.equal(candidates[1].posted, true);
});

// #829 (RED TEAM PASS MEDIUM 1): a head that was already pushed and named in
// the same paragraph is the current head even when the request says "new head".
test('a pushed head plus a new-head request is a same-head request', () => {
  const pushed = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `RED TEAM findings at \`${OLD}\` fixed at **\`${SHORT}\`** (pushed, not merged). Please re-review the new head.`,
  };
  assert.equal(isRequestComment(pushed), true);
  assert.equal(isSameHeadRequest(pushed, HEAD), true);
  const result = evaluate([pushed]);
  assert.equal(result.stalled, true);

  const future = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `RED TEAM BLOCK/FAIL recorded at ${HEAD}. Standing rule: fix every finding, push, and ask RED TEAM to re-review the new head.`,
  };
  assert.equal(isSameHeadRequest(future, HEAD), false);
  const quiet = evaluate([future]);
  assert.equal(quiet.stalled, false);
  assert.equal(quiet.reason, 'awaiting-push');
});

// #829 (RED TEAM PASS MEDIUM 2): an unrelated negation in an earlier clause
// must not swallow a genuine request.
test('unrelated negation does not suppress a real request', () => {
  const samples = [
    `No findings remain. Requesting a RED TEAM re-check on \`${SHORT}\`.`,
    `No code changed, please re-review \`${SHORT}\`.`,
    `Nothing to merge yet; requesting a RED TEAM re-check on \`${SHORT}\`.`,
  ];
  for (const body of samples) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(evaluate([comment]).stalled, true, body);
  }

  const negated = [
    `No RED TEAM re-check is needed on \`${SHORT}\`; the head did not move.`,
    `No, please re-review \`${SHORT}\`.`,
    `There is not a RED TEAM re-review request on \`${SHORT}\` yet.`,
  ];
  for (const body of negated) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }
});

// #829 (RED TEAM PASS MEDIUM 3): completed-review discussion is history, not a
// new ask. Code-formatted negation still counts as negation.
test('completed discussion and formatted negation do not create requests', () => {
  const inert = [
    `The RED TEAM re-review requested yesterday on \`${SHORT}\` was completed.`,
    `A RED TEAM re-review requested on \`${SHORT}\` has already been answered.`,
    `\`No\` RED TEAM re-check is needed on \`${SHORT}\`.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }

  const genuine = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `RED TEAM re-review requested on \`${SHORT}\` — all checks green.`,
  };
  assert.equal(isRequestComment(genuine), true);
  assert.equal(evaluate([genuine]).stalled, true);
});

// #829 (RED TEAM PASS MEDIUM 4): indented code, a shorter inner fence, HTML
// comments and lazy quote continuation are examples, never verdict scope.
test('indented, nested-fence, HTML and lazy-quote examples are inert', () => {
  const body = [
    '[RED TEAM]',
    'VERDICT: PASS',
    '',
    '    VERDICT: FAIL',
    `    Commit checked: ${OLD}`,
    '',
    '````',
    '```',
    `Commit checked: ${OLD}`,
    '```',
    '````',
    '',
    `<!-- Commit checked: ${OLD} -->`,
    '',
    `> Commit checked: ${OLD}`,
    `Commit checked: ${OLD}`,
    '',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(body), 'PASS');
  assert.equal(checkedHead(body), HEAD);

  const ambiguous = [`Commit checked: ${HEAD}`, `Commit checked: ${OLD}`].join('\n');
  assert.equal(checkedHead(ambiguous), null);
});

// #829 (RED TEAM PASS MEDIUM 5): a request only binds to a head visible in its
// own sentence; fenced/quoted history and incidental mentions cannot bind it.
test('inert history cannot bind a request to the current head', () => {
  const fenced = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: [
      `RED TEAM re-review requested on \`${OLD}\`.`,
      '```',
      `current head ${SHORT}`,
      '```',
    ].join('\n'),
  };
  assert.equal(isRequestComment(fenced), true);
  const stale = evaluate([fenced]);
  assert.equal(stale.stalled, false);
  assert.equal(stale.reason, 'no-request-for-head');

  const incidental = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `RED TEAM re-review requested on \`${OLD}\`. The current head ${SHORT} is unrelated.`,
  };
  assert.equal(evaluate([incidental]).stalled, false);

  const inline = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `Requesting a RED TEAM re-check on \`${SHORT}\`.`,
  };
  assert.equal(evaluate([inline]).stalled, true);
});

// #832 (MEDIUM 1): a future-push instruction names the head it wants fixed, so
// it must not bind a current-head alert; a soft-wrapped pushed-current request
// must behave like the same prose on one line; URLs and incidental current SHAs
// must not bind a request for another head.
test('future pushes, source links and incidental heads do not bind a request', () => {
  const future = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `Fix \`${SHORT}\`, push, then please re-review the new head.`,
  };
  assert.equal(isRequestComment(future), true);
  assert.equal(isSameHeadRequest(future, HEAD), false);
  assert.equal(evaluate([future]).reason, 'awaiting-push');

  const relay = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `RED TEAM BLOCK/FAIL recorded at ${HEAD}. Standing rule: fix every finding, push, and ask RED TEAM to re-review the new head.`,
  };
  assert.equal(isSameHeadRequest(relay, HEAD), false);
  assert.equal(evaluate([relay]).reason, 'awaiting-push');

  const linked = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `RED TEAM re-review requested on \`${OLD}\` — source https://github.com/RDW-Labz/bingo-auctions/commit/${HEAD}`,
  };
  assert.equal(isRequestComment(linked), true);
  assert.equal(isSameHeadRequest(linked, HEAD), false);
  assert.equal(evaluate([linked]).reason, 'awaiting-push');

  const incidental = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `Please re-review the new head; the current head ${SHORT} is unrelated.`,
  };
  assert.equal(isSameHeadRequest(incidental, HEAD), false);

  const oneLine = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `Pushed \`${SHORT}\`, please re-review the new head.`,
  };
  const softWrapped = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `The new head \`${SHORT}\` is pushed\nplease re-review it.`,
  };
  for (const comment of [oneLine, softWrapped]) {
    assert.equal(isSameHeadRequest(comment, HEAD), true, comment.body);
    assert.equal(evaluate([comment]).stalled, true, comment.body);
  }
});

// #832 (MEDIUM 2): completion of the review itself is history; completion of
// the prerequisite fixes is not, and must leave a genuine request live.
test('review completion and prerequisite completion are classified separately', () => {
  const history = [
    `The RED TEAM re-review was completed on ${SHORT}.`,
    `A RED TEAM re-review on \`${SHORT}\` has already been answered.`,
    `The answered re-check on \`${SHORT}\` is closed.`,
    `Nobody requested a RED TEAM re-review on \`${SHORT}\`.`,
    `No RED TEAM re-review was requested on \`${SHORT}\`.`,
  ];
  for (const body of history) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }

  const genuine = [
    `RED TEAM re-review requested on \`${SHORT}\` after the fixes were completed.`,
    `Please re-review \`${SHORT}\` once the checks are completed.`,
  ];
  for (const body of genuine) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(evaluate([comment]).stalled, true, body);
  }
});

// #832 (MEDIUM 3): markdown masking must neither hide a real top-level verdict
// after quoted/HTML/fenced examples nor accept example text as a request.
test('markdown masks keep real verdicts and reject example requests', () => {
  const fencedHtml = [
    '```',
    '<!-- example opener with no close',
    '```',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(fencedHtml), 'PASS');
  assert.equal(checkedHead(fencedHtml), HEAD);

  const quoted = [
    '> quoted history',
    '## Verdict',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(quoted), 'PASS');
  assert.equal(checkedHead(quoted), HEAD);

  const thematic = [
    '> quoted history',
    '---',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(thematic), 'PASS');
  assert.equal(checkedHead(thematic), HEAD);

  const liveHtml = [
    '<!--',
    '[RED TEAM]',
    'VERDICT: FAIL',
    `Commit checked: ${OLD}`,
    '-->',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(liveHtml), 'PASS');
  assert.equal(checkedHead(liveHtml), HEAD);

  const example = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: [
      'Some prose before.',
      '``',
      `Requesting a RED TEAM re-check on \`${SHORT}\`.`,
      '``',
    ].join('\n'),
  };
  assert.equal(isRequestComment(example), false);
  assert.equal(evaluate([example]).stalled, false);

  const multiline = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `\`\`a \` b\`\` Requesting a RED TEAM re-check on \`${SHORT}\`.`,
  };
  assert.equal(isRequestComment(multiline), true);
  assert.equal(evaluate([multiline]).stalled, true);
});

// #832: masking must preserve character offsets (request match indices are
// reused against the authored body) and stay bounded on hostile input.
test('masking preserves offsets and stays bounded', () => {
  const bodies = [
    'plain text with `code` and "quotes"',
    ['> quote', '## heading', '```', '<!--', '```', '[RED TEAM]', 'VERDICT: PASS'].join('\n'),
    '``a ` b`` Requesting a RED TEAM re-check on `deadbeef`.',
    '<!-- open\nstill open\n--> tail',
  ];
  for (const body of bodies) {
    assert.equal(maskInertText(body).length, maskHistory(body).length, body);
  }

  const hostile = '`'.repeat(20_000) + 'x' + '``a ` b` '.repeat(2_000);
  const started = Date.now();
  maskInertText(hostile);
  assert.ok(Date.now() - started < 1000);
});

// #834 (MEDIUM 1): an imperative that names the actual new head is a current
// head request even without an extra "pushed" word. Future pushes and asides
// stay quiet.
test('#834 MEDIUM 1: explicit current-head imperatives bind without pushed', () => {
  const direct = [
    `Please re-review the new head \`${SHORT}\`.`,
    `Please re-review ${SHORT}.`,
    `Please re-review the current head \`${SHORT}\` now.`,
  ];
  for (const body of direct) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
    assert.equal(evaluate([comment]).stalled, true, body);
  }

  const future = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `Fix \`${SHORT}\`, push, then please re-review the new head.`,
  };
  assert.equal(isSameHeadRequest(future, HEAD), false);
  assert.equal(evaluate([future]).reason, 'awaiting-push');

  const aside = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `Please re-review the new head; the current head ${SHORT} is unrelated.`,
  };
  assert.equal(isSameHeadRequest(aside, HEAD), false);
});

// #834 (MEDIUM 2): a reason clause cannot negate the request; standalone
// passive negation stays inert.
test('#834 MEDIUM 2: negation binds to its own event', () => {
  const live = [
    `Please re-review \`${SHORT}\` because no review was requested on it.`,
    `Requesting a RED TEAM re-check on \`${SHORT}\` since no re-check was needed before.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(evaluate([comment]).stalled, true, body);
  }

  const inert = [
    `The RED TEAM re-review was not requested on \`${SHORT}\`.`,
    `No RED TEAM re-check is needed on \`${SHORT}\` because the head did not move.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }
});

// #834 (MEDIUM 3): completion binds to the review it describes; an old
// completed review cannot hide a current imperative, and a soft-wrapped or
// status completion is still history.
test('#834 MEDIUM 3: completion binds to its particular event', () => {
  const live = [
    `The RED TEAM re-review on \`${OLD}\` was completed, so please re-review \`${SHORT}\`.`,
    `The RED TEAM re-review on \`${OLD}\` was completed so please re-review \`${SHORT}\`.`,
    `The review and the fixes were both completed; please re-review \`${SHORT}\`.`,
    `Please re-review \`${SHORT}\` because the old review was completed on \`${OLD}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(evaluate([comment]).stalled, true, body);
  }

  const history = [
    `The RED TEAM re-review on \`${SHORT}\`\nwas completed.`,
    `RED TEAM re-review requested on \`${SHORT}\` — completed.`,
  ];
  for (const body of history) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }
});

// #834 (MEDIUM 4): an unmatched tick in one Markdown block cannot pair with a
// tick in another block and hide the genuine fields between them.
test('#834 MEDIUM 4: inline code never pairs across Markdown blocks', () => {
  const separatorCases = [
    ['`first paragraph', '', 'second paragraph`'],
    ['`first paragraph', '- list item', 'second paragraph`'],
    ['`first paragraph', '1. ordered item', 'second paragraph`'],
    ['`first paragraph', '2) ordered item', 'second paragraph`'],
    ['`first paragraph', '## heading', 'second paragraph`'],
  ];
  for (const [open, middle, close] of separatorCases) {
    const body = [
      open,
      middle,
      '[RED TEAM]',
      'VERDICT: PASS',
      `Commit checked: ${HEAD}`,
      close,
    ].join('\n');
    assert.equal(verdictKind(body), 'PASS', body);
    assert.equal(checkedHead(body), HEAD, body);
  }

  const withinParagraph = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: ['`example', `Requesting a RED TEAM re-check on ${SHORT}\``].join('\n'),
  };
  assert.equal(isRequestComment(withinParagraph), false);
});

// #834 (MEDIUM 5): ordered-list markers separate request targets, while genuine
// soft-wrapped prose still binds.
test('#834 MEDIUM 5: ordered list items isolate request targets', () => {
  const borrowed = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: [`1) pushed \`${SHORT}\``, `2) please re-review \`${OLD}\``].join('\n'),
  };
  assert.equal(isSameHeadRequest(borrowed, HEAD), false);

  const borrowedParen = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: [`1. pushed \`${SHORT}\``, `2. please re-review \`${OLD}\``].join('\n'),
  };
  assert.equal(isSameHeadRequest(borrowedParen, HEAD), false);

  const softWrapped = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `Pushed \`${SHORT}\`,\nplease re-review it.`,
  };
  assert.equal(isSameHeadRequest(softWrapped, HEAD), true);
  assert.equal(evaluate([softWrapped]).stalled, true);
});

// #834 (MEDIUM 6): HTML comment openers inside inline code are example text and
// cannot swallow a later genuine verdict; real HTML comments stay inert.
test('#834 MEDIUM 6: HTML openers inside inline code stay inert', () => {
  const bodies = [
    ['`<!--`', '[RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`],
    ['``<!--``', '[RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`],
  ];
  for (const lines of bodies) {
    const body = lines.join('\n');
    assert.equal(verdictKind(body), 'PASS', body);
    assert.equal(checkedHead(body), HEAD, body);
  }

  const real = [
    '<!--',
    '[RED TEAM]',
    'VERDICT: FAIL',
    `Commit checked: ${OLD}`,
    '-->',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(real), 'PASS');
  assert.equal(checkedHead(real), HEAD);
});

// #834 (MEDIUM 7): a multiline variable-delimiter code example cannot be the
// only checked-head field, while a genuine code-formatted SHA still parses.
test('#834 MEDIUM 7: code examples cannot supply checked-head scope', () => {
  const example = ['[RED TEAM]', 'VERDICT: PASS', '', '``', `Commit checked: ${HEAD}`, '``'].join(
    '\n',
  );
  assert.equal(verdictKind(example), 'PASS');
  assert.equal(checkedHead(example), null);
  assert.equal(isVerdictComment({ at: T, app: RED_TEAM_APP, body: example }, HEAD), false);
  assert.equal(evaluate([request(), { at: T, app: RED_TEAM_APP, body: example }]).stalled, true);

  assert.equal(checkedHead(`Commit checked: \`${HEAD}\``), HEAD);
  assert.equal(checkedHead(`**Commit checked:** \`${SHORT}\``), SHORT);
});

// #834 (MEDIUM 8): incidental current-head asides never bind an other-head or
// future-push request; true current-head asks remain live.
test('#834 MEDIUM 8: incidental heads never bind a request', () => {
  const asides = [
    `Please re-review \`${OLD}\`, the current head \`${SHORT}\` is unrelated.`,
    `Please re-review \`${OLD}\` (current head ${SHORT} for reference).`,
    `Fix \`${SHORT}\`, push, then please re-review the new head.`,
  ];
  for (const body of asides) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }

  const live = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `Please re-review \`${SHORT}\`.`,
  };
  assert.equal(isSameHeadRequest(live, HEAD), true);
  assert.equal(evaluate([live]).stalled, true);
});

// #836 (MEDIUM 1): the checked-commit field's SHA must be its own value. An
// unavailable field followed by a source SHA, URL or overlong token cannot
// establish verdict scope; plain and code-formatted fields still parse and two
// different fields stay ambiguous.
test('#836 MEDIUM 1: checked-head suffix is anchored to the field value', () => {
  const rejected = [
    `Commit checked: unavailable — source \`${OLD}\``,
    `Commit checked: unavailable https://github.com/x/y/commit/${OLD}`,
    `Commit checked: not available, source ${OLD}`,
    `Commit checked: - ${OLD}`,
    `Commit checked: ${'a'.repeat(41)}`,
  ];
  for (const body of rejected) {
    assert.equal(checkedHead(body), null, body);
  }

  assert.equal(checkedHead(`Commit checked: ${HEAD}`), HEAD);
  assert.equal(checkedHead(`Commit checked: \`${SHORT}\``), SHORT);
  assert.equal(checkedHead(`**Commit checked:** \`${SHORT}\``), SHORT);
  assert.equal(checkedHead(`Commit checked: ${HEAD}\nCommit checked: ${OLD}`), null);
});

// #836 (MEDIUM 2): a valid multiline code span inside a list item is example
// text and cannot create a stalled request; separate items and blank-separated
// prose remain live.
test('#836 MEDIUM 2: multiline code inside list items stays inert', () => {
  const inert = [
    `- Example \`multi\n  line requesting a RED TEAM re-check on ${SHORT}\``,
    `1. Example \`multi\n   line requesting a RED TEAM re-check on ${SHORT}\``,
    `- item \`code\n  request a RED TEAM re-check on ${SHORT}\`\n- second item plain`,
    `- Example\n\n  \`\`\`\n  Requesting a RED TEAM re-check on \`${SHORT}\`.\n  \`\`\``,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }

  const live = [
    `- Example \`multi\n\n  line requesting a RED TEAM re-check on ${SHORT}\``,
    `- first item \`a\n- second item requesting a RED TEAM re-check on ${SHORT}\``,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
  }
});

// #836 (MEDIUM 3): backticks inside a real HTML comment cannot hide its close,
// and a code literal after a comment closes cannot open false HTML state; real
// comments stay inert while later genuine verdicts remain visible.
test('#836 MEDIUM 3: HTML/code precedence never hides genuine verdicts', () => {
  const bodies = [
    [
      '<!-- comment',
      '--> then `code <!-- literal` continues',
      '[RED TEAM]',
      'VERDICT: PASS',
      `Commit checked: ${HEAD}`,
    ],
    ['<!-- note `x', '--> [RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`, 'closing`'],
    [
      '<!-- real `tick` comment',
      'still comment `x',
      '-->',
      '[RED TEAM]',
      'VERDICT: PASS',
      `Commit checked: ${HEAD}`,
    ],
    ['<!-- a -->', 'then `<!--` example', '[RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`],
  ];
  for (const lines of bodies) {
    const body = lines.join('\n');
    assert.equal(verdictKind(body), 'PASS', body);
    assert.equal(checkedHead(body), HEAD, body);
  }

  const inert = [
    [
      '<!--',
      '[RED TEAM]',
      'VERDICT: FAIL',
      `Commit checked: ${OLD}`,
      '-->',
      '[RED TEAM]',
      'VERDICT: PASS',
      `Commit checked: ${HEAD}`,
    ],
  ];
  for (const lines of inert) {
    const body = lines.join('\n');
    assert.equal(verdictKind(body), 'PASS', body);
    assert.equal(checkedHead(body), HEAD, body);
  }
});

// #836 (MEDIUM 4): completion classification attaches to the review event. A
// "not completed" or "pending" review is a status statement, not a fresh ask;
// an older completed review cannot suppress a live current imperative; completed
// discussion does not create or reset a request.
test('#836 MEDIUM 4: completion classification binds to the review event', () => {
  const live = [
    `The re-review of \`${OLD}\` was completed and please re-review \`${SHORT}\`.`,
    `The fixes were completed and please re-review \`${SHORT}\`.`,
    `The re-review was not completed, so please re-review \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
  }

  const descriptive = [
    `The re-review requested on \`${SHORT}\` was not completed.`,
    `The re-review requested on \`${SHORT}\` is still pending.`,
    `The re-review requested on \`${SHORT}\` was completed.`,
    `The completed re-review discussion is now closed.`,
  ];
  for (const body of descriptive) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }
});

// #836 (MEDIUM 5): "review the current head against the previous head" and
// "review X for unrelated regressions" name a genuine target even though the
// same segment carries an incidental word; a current head used only as a
// reference stays quiet.
test('#836 MEDIUM 5: incidental-word filtering keeps genuine targets', () => {
  const live = [
    `Please review the current head \`${SHORT}\` against the previous head.`,
    `Please review \`${SHORT}\` for unrelated regressions.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }

  const quiet = [
    `Please review \`${OLD}\`, the current head \`${SHORT}\` is a reference only.`,
    `Please review \`${OLD}\`; the current head \`${SHORT}\` is a reference only.`,
  ];
  for (const body of quiet) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
  }
});

// #836 (MEDIUM 6): a historical negation in an earlier event cannot cancel a
// current affirmative request, with or without commas; standalone negation
// stays inert.
test('#836 MEDIUM 6: historical negation does not suppress a new request', () => {
  const live = [
    `No review was requested on \`${OLD}\`, so please review \`${SHORT}\`.`,
    `No review was requested on \`${OLD}\` so please review \`${SHORT}\`.`,
    `No review was requested on \`${OLD}\` because please review \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
  }

  const inert = [
    `No RED TEAM re-check is needed on \`${SHORT}\`.`,
    `No review was requested on \`${SHORT}\`.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }
});

// #836 (MEDIUM 7): equivalent future-push instructions stay awaiting a push
// whether or not they use the "new head" phrase; an already-pushed request still
// alerts.
test('#836 MEDIUM 7: future-push protection does not depend on wording', () => {
  const awaiting = [
    `Fix \`${SHORT}\`, push, then please re-review.`,
    `Fix \`${SHORT}\`, push, then please re-review the new head.`,
    `Address \`${SHORT}\`; push; then request a re-check.`,
  ];
  for (const body of awaiting) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
  }

  const alreadyPushed = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `Pushed \`${SHORT}\`; please re-review \`${SHORT}\`.`,
  };
  assert.equal(isSameHeadRequest(alreadyPushed, HEAD), true);
});

// #836 (MEDIUM 8): thematic breaks and setext underlines separate unmatched
// ticks so a real verdict stays visible; valid same-paragraph spans stay inert.
test('#836 MEDIUM 8: thematic breaks separate unmatched inline code', () => {
  const breaks = [
    ['`before', '---', '[RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`, '`'],
    ['`before', '***', '[RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`, '`'],
    ['`before', '___', '[RED TEAM]', 'VERDICT: PASS', `Commit checked: ${HEAD}`, '`'],
    [
      '`before',
      'Heading',
      '=======',
      '[RED TEAM]',
      'VERDICT: PASS',
      `Commit checked: ${HEAD}`,
      '`',
    ],
  ];
  for (const lines of breaks) {
    const body = lines.join('\n');
    assert.equal(verdictKind(body), 'PASS', body);
    assert.equal(checkedHead(body), HEAD, body);
  }

  const withinParagraph = {
    at: T,
    app: 0,
    user: 'btabor11',
    body: `Here is \`Requesting a RED TEAM re-check on ${SHORT}\` done.`,
  };
  assert.equal(isRequestComment(withinParagraph), false);
});

// #838 (MEDIUM 1): a backtick inside one real HTML comment cannot pair with a
// tick outside and expose a second comment's verdict fields. Inline code takes
// precedence only when it starts first; a real comment masks its own ticks.
test('#838 MEDIUM 1: ticks inside real comments cannot expose hidden verdicts', () => {
  const hiddenFail = [
    '<!-- first ` tick -->',
    '<!-- [RED TEAM]',
    'VERDICT: FAIL',
    `Commit checked: ${OLD}`,
    '--> ` tail',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(hiddenFail), 'PASS');
  assert.equal(checkedHead(hiddenFail), HEAD);

  const hiddenPass = [
    '<!-- first ` tick -->',
    '<!-- [RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${OLD}`,
    '--> ` tail',
    '[RED TEAM]',
    'VERDICT: FAIL',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(hiddenPass), 'FAIL');
  assert.equal(checkedHead(hiddenPass), HEAD);

  // A real comment stays inert even with unmatched ticks on both sides.
  const unmatched = ['<!-- note `x', 'VERDICT: FAIL', `Commit checked: ${OLD}`, '--> tail `y'].join(
    '\n',
  );
  assert.equal(verdictKind(unmatched), null);
  assert.equal(checkedHead(unmatched), null);

  // A code span cannot pair across a blank line and expose a real comment.
  const blockSpan = [
    '`opener',
    '',
    '<!-- [RED TEAM]',
    'VERDICT: FAIL',
    `Commit checked: ${OLD}`,
    '-->',
    'closer`',
  ].join('\n');
  assert.equal(verdictKind(blockSpan), null);
  assert.equal(checkedHead(blockSpan), null);

  // Inline code that opens first still owns its `<!--` literal.
  const codeFirst = [
    '`<!--` literal then `code`',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(verdictKind(codeFirst), 'PASS');
  assert.equal(checkedHead(codeFirst), HEAD);
});

// #838 (MEDIUM 2): a current head mentioned only as a reference is not the
// request target; a genuine imperative that names it still binds.
test('#838 MEDIUM 2: reference-only heads do not become the target', () => {
  const quiet = [
    `Please re-review \`${OLD}\` (not \`${SHORT}\`).`,
    `Please re-review \`${OLD}\` other than \`${SHORT}\`.`,
    `Please re-review \`${OLD}\`; the current head \`${SHORT}\` is for reference.`,
  ];
  for (const body of quiet) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
  }

  const live = [
    `Please re-review \`${SHORT}\`.`,
    `Please re-review the current head \`${SHORT}\` against \`${OLD}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }
});

// #838 (MEDIUM 3): "pending/ongoing" work is a live imperative; a status
// statement about the review itself is descriptive.
test('#838 MEDIUM 3: pending work is not review status', () => {
  const live = [
    `Please re-review pending changes on \`${SHORT}\`.`,
    `Please re-review the ongoing changes on \`${SHORT}\`.`,
    `Please re-review outstanding items on \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(evaluate([comment]).stalled, true, body);
  }

  const status = [
    `The RED TEAM re-review requested on \`${SHORT}\` is still pending.`,
    `The re-review on \`${SHORT}\` is ongoing.`,
    `The re-review requested on \`${SHORT}\` remains outstanding.`,
  ];
  for (const body of status) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }
});

// #838 (MEDIUM 4): a follow-on request is not a push dependency; only a real
// fix/push/re-review sequence waits for a new head.
test('#838 MEDIUM 4: ordinary follow-on requests stay live', () => {
  const live = [
    `Please re-review the new head \`${SHORT}\` and then request approval.`,
    `Please review the current head \`${SHORT}\` and then request approval.`,
    `Please re-review the new head \`${SHORT}\`; then request approval.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }

  const future = `Fix \`${SHORT}\`, push, then please re-review the new head.`;
  const comment = { at: T, app: GROK_APP, user: 'Btabor11', body: future };
  assert.equal(isRequestComment(comment), true);
  assert.equal(isSameHeadRequest(comment, HEAD), false);
  assert.equal(evaluate([comment]).reason, 'awaiting-push');
});

// #838 (MEDIUM 5): "requested and completed" is one completed event; an older
// completion cannot suppress a fresh imperative.
test('#838 MEDIUM 5: coordinated completion attaches to its own review', () => {
  const history = [
    `The RED TEAM re-review was requested and completed on \`${SHORT}\`.`,
    `RED TEAM re-review requested on \`${SHORT}\` and then completed.`,
    `The re-review on \`${SHORT}\` was requested and completed.`,
  ];
  for (const body of history) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }

  const live = [
    `The old review was completed and please re-review \`${SHORT}\`.`,
    `The re-review of \`${OLD}\` was completed and then please re-review \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
  }
});

// #838 (MEDIUM 6): a coordinated prohibited verb list is inert even with a
// comma; an independent imperative after unrelated negation stays live.
test('#838 MEDIUM 6: coordinated prohibition keeps its negation', () => {
  const inert = [
    `Do not comment and request a re-review on \`${SHORT}\`.`,
    `Do not comment, and request a re-review on \`${SHORT}\`.`,
    `Don't merge or request a re-review on \`${SHORT}\`.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }

  const live = [
    `No findings remain, please re-review \`${SHORT}\`.`,
    `Do not worry, please re-review \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
  }
});

// #838 (MEDIUM 7): a historical "not requested" on another head does not cancel
// a later affirmative imperative, with or without punctuation.
test('#838 MEDIUM 7: historical negation does not cancel a new imperative', () => {
  const live = [
    `No review was requested on ${OLD} please re-review ${SHORT}.`,
    `No review was requested on ${OLD}, please re-review ${SHORT}.`,
    `No review was requested on ${OLD}; please re-review ${SHORT}.`,
    `There was not a review requested on ${OLD} please re-review ${SHORT}.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
  }

  const inert = [
    `The RED TEAM re-review was not requested on \`${SHORT}\`.`,
    `No RED TEAM re-check is needed on \`${SHORT}\`.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }
});

// #838 (MEDIUM 8): semicolon-joined and soft-wrapped fix/push/re-review
// instructions still wait for a push; already-pushed requests stay live.
test('#838 MEDIUM 8: semicolon and soft-wrap push dependencies are kept', () => {
  const awaiting = [
    `Fix \`${SHORT}\`; push; then please re-review \`${SHORT}\`.`,
    `Fix \`${SHORT}\`; push;\nthen please re-review the new head.`,
    `Address \`${SHORT}\`; push; then request a re-check on \`${SHORT}\`.`,
  ];
  for (const body of awaiting) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
  }

  const live = [
    `Pushed \`${SHORT}\`; please re-review \`${SHORT}\`.`,
    `Pushed \`${SHORT}\`,\nplease re-review the new head.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }
});

// --- #841 follow-up regressions (RED TEAM PASS at ea1f1cb2 on #840) ---------

test('#841 MEDIUM 1: comment-contained ticks and fences keep real verdicts visible', () => {
  const hidden = [
    '<!-- ``` -->',
    '<!-- `tick` and ``` fence -->',
    '[RED TEAM]',
    'VERDICT: FAIL',
    `Commit checked: ${HEAD}`,
    '',
    'finding.',
  ].join('\n');
  assert.equal(checkedHead(hidden), HEAD);
  assert.equal(verdictKind(hidden), 'FAIL');

  const openComment = [
    '<!-- contains `tick`',
    'still ``` inside',
    '-->',
    '[RED TEAM]',
    'VERDICT: PASS',
    `Commit checked: ${HEAD}`,
  ].join('\n');
  assert.equal(checkedHead(openComment), HEAD);
  assert.equal(verdictKind(openComment), 'PASS');

  // Hidden examples stay inert: a verdict inside a fence is not a verdict.
  const fenced = ['```', '[RED TEAM]', 'VERDICT: FAIL', `Commit checked: ${HEAD}`, '```'].join(
    '\n',
  );
  assert.equal(checkedHead(fenced), null);
  assert.equal(verdictKind(fenced), null);

  // A real request after hidden comment examples is still a request.
  const requestAfter = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    url: 'u',
    body: ['<!-- ``` -->', '<!-- `tick` -->', `RED TEAM re-review requested on \`${SHORT}\`.`].join(
      '\n',
    ),
  };
  assert.equal(isRequestComment(requestAfter), true);
  assert.equal(isSameHeadRequest(requestAfter, HEAD), true);
});

test('#841 MEDIUM 2: comparison SHAs are references, not review targets', () => {
  const notTarget = [
    `Please re-review ${OLD} rather than \`${SHORT}\`.`,
    `Please re-review ${OLD} instead of \`${SHORT}\`.`,
    `Please re-review the changes against \`${SHORT}\`.`,
    `Please re-review ${OLD} compared to \`${SHORT}\`.`,
    `Please re-review ${OLD} versus \`${SHORT}\`.`,
  ];
  for (const body of notTarget) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
    assert.notEqual(evaluate([comment]).reason, 'stalled-since-recheck', body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }

  const genuineTarget = [
    `Please re-review \`${SHORT}\` instead of ${OLD}.`,
    `Please re-review \`${SHORT}\` rather than ${OLD}.`,
    `Please review the current head \`${SHORT}\` against the previous head.`,
  ];
  for (const body of genuineTarget) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }
});

test('#841 MEDIUM 3: soft-wrapped and plain review future pushes do not alert', () => {
  const future = [
    `Fix the finding, push,\nthen request a review on \`${SHORT}\`.`,
    `Fix the finding; push; then request a review on \`${SHORT}\`.`,
    `Fix the finding, push,\nthen request a re-review on \`${SHORT}\`.`,
    `Fix the finding, push, then ask for a re-review on \`${SHORT}\`.`,
    `Fix \`${SHORT}\`, push, then please re-review the new head.`,
  ];
  for (const body of future) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), false, body);
    assert.equal(evaluate([comment]).reason, 'awaiting-push', body);
  }

  const pushed = {
    at: T,
    app: GROK_APP,
    user: 'Btabor11',
    body: `Pushed the fix — please re-review \`${SHORT}\`.`,
  };
  assert.equal(isSameHeadRequest(pushed, HEAD), true);
  assert.equal(evaluate([pushed]).stalled, true);
});

test('#841 MEDIUM 4: a direct prohibition wins over historical context', () => {
  const prohibited = [
    `I requested a re-review on \`${SHORT}\` yesterday. Do not request a re-review on \`${SHORT}\`.`,
    `I requested a re-review on ${OLD} yesterday. Never request a re-review on \`${SHORT}\`.`,
    `We reviewed \`${SHORT}\` earlier. Do not request a re-review on \`${SHORT}\`.`,
  ];
  for (const body of prohibited) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
    assert.equal(evaluate([comment]).stalled, false, body);
  }

  const live = `No review was requested on ${OLD}, so please review \`${SHORT}\`.`;
  assert.equal(isRequestComment({ at: T, app: 0, user: 'btabor11', body: live }), true);
  assert.equal(isSameHeadRequest({ at: T, app: 0, user: 'btabor11', body: live }, HEAD), true);
});

test('#841 MEDIUM 5: independent requests beside a separate prohibition stay live', () => {
  const live = [
    `Do not merge the failing build; please re-review \`${SHORT}\`.`,
    `Please re-review \`${SHORT}\`; do not merge the failing build.`,
    `Do not merge the failing build. Please re-review \`${SHORT}\`.`,
    `Do not mark needs-braden, and please re-review \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: GROK_APP, user: 'Btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }

  const inert = [
    `Do not request a re-review on \`${SHORT}\`.`,
    `Do not comment and request a re-review on \`${SHORT}\`.`,
    `Don't merge or request a re-review on \`${SHORT}\`.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }
});

test('#841 MEDIUM 6: status variants neither create nor reset a request', () => {
  const statuses = [
    `The re-review requested on \`${SHORT}\` is currently pending.`,
    `Re-review requested on \`${SHORT}\` — pending.`,
    `Re-review requested on \`${SHORT}\`: pending.`,
    `Re-review requested on \`${SHORT}\`, currently pending.`,
    `The re-review requested on \`${SHORT}\` is still awaiting.`,
    `The re-review requested on \`${SHORT}\` was not completed.`,
  ];
  for (const body of statuses) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }

  // Pending-work imperatives stay live.
  const imperative = `Re-review requested on \`${SHORT}\` is currently pending. Please re-review \`${SHORT}\`.`;
  assert.equal(isRequestComment({ at: T, app: 0, user: 'btabor11', body: imperative }), true);

  // A status update does not reset the earlier request's timer.
  const statusLater = {
    at: iso(T_PLUS_59),
    app: 0,
    user: 'btabor11',
    url: 'u',
    body: `Re-review requested on \`${SHORT}\`, currently pending.`,
  };
  const result = evaluate([request(), statusLater]);
  assert.equal(result.stalled, true);
  assert.equal(result.requestAt, T);
});

test('#841 MEDIUM 7: old completion does not consume a new request', () => {
  const live = [
    `The old review was completed and a re-review is requested on \`${SHORT}\`.`,
    `The old review was completed and a re-review was requested on \`${SHORT}\`.`,
    `The old review was completed, so a re-review is requested on \`${SHORT}\`.`,
    `The old review was completed and please re-review \`${SHORT}\`.`,
  ];
  for (const body of live) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), true, body);
    assert.equal(isSameHeadRequest(comment, HEAD), true, body);
  }

  const inert = [
    `A re-review was requested on \`${SHORT}\` yesterday and stopped.`,
    `A re-review was requested on \`${SHORT}\` earlier. It was completed.`,
    `The re-review requested on \`${SHORT}\` was completed.`,
  ];
  for (const body of inert) {
    const comment = { at: T, app: 0, user: 'btabor11', body };
    assert.equal(isRequestComment(comment), false, body);
  }
});
