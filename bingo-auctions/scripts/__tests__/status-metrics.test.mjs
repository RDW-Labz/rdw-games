// Business metrics snapshot (#725). Fake aggregates only: no real users,
// invoices or addresses.
// Run: node --test scripts/__tests__/status-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNT_HISTORY_KEYS,
  COUNT_METRICS,
  MIN_COHORT,
  MONEY_METRICS,
  QUERY,
  WINDOWS,
  assertMetricsShape,
  assertReadOnly,
  bucketUnder5,
  buildMetrics,
  buildQuery,
  decideLedgerSource,
  mergeFrozenDays,
  nextCountHistory,
  parseFrozenDays,
  publishableDays,
  readOnlyBody,
  requiredAliases,
  suppressComplementary,
  suppressNestedCounts,
} from '../metrics-status/lib.mjs';

const NOW = new Date('2026-11-05T13:15:00Z');
const DAY_MS = 86_400_000;
const TODAY_UTC = Date.UTC(2026, 10, 5);

function isoDay(offset) {
  return new Date(TODAY_UTC + offset * DAY_MS).toISOString().slice(0, 10);
}

function bucket(offset, contributors = 6, amount = 12) {
  return { day: isoDay(offset), contributors, amount, fingerprint: 1 };
}

function safeBuckets(amount = 12, contributors = 6) {
  const out = [];
  for (let offset = -30; offset <= -1; offset += 1) out.push(bucket(offset, contributors, amount));
  return out;
}

function row(overrides = {}) {
  const base = {};
  for (const alias of requiredAliases()) base[alias] = 12;
  base.gross_sales_days = safeBuckets();
  // No refunds by default: the old fixture had gross and refunds with the same
  // 6-customer cohorts, which is exactly the subtractive-disclosure case.
  base.refund_days = [];
  for (const window of WINDOWS) {
    base[`refund_contributors_${window}`] = 0;
    base[`refund_count_${window}`] = 0;
  }
  return { ...base, ...overrides };
}

function emptyCountHistoryFields() {
  const values = {};
  const sizes = {};
  for (const key of COUNT_HISTORY_KEYS) {
    values[key] = [];
    sizes[key] = 0;
  }
  return { count_history: values, count_history_sizes: sizes };
}

function withCountHistory(frozen) {
  return { ...emptyCountHistoryFields(), ...frozen };
}

test('the query is one read-only SELECT with no semicolon', () => {
  assert.match(QUERY.trim(), /^WITH\b/i);
  assert.doesNotThrow(() => assertReadOnly(QUERY));
  assert.throws(() => assertReadOnly('DELETE FROM invoices'), /only SELECT\/WITH/);
  assert.throws(() => assertReadOnly('SELECT 1; SELECT 2'), /no semicolons/);
});

test('assertReadOnly rejects data-modifying CTEs, SELECT INTO and hidden keywords', () => {
  assert.throws(
    () => assertReadOnly('WITH x AS (DELETE FROM invoices RETURNING *) SELECT * FROM x'),
    /DELETE/,
  );
  assert.throws(
    () => assertReadOnly('WITH x AS (UPDATE invoices SET status = NULL RETURNING *) SELECT 1'),
    /UPDATE/,
  );
  assert.throws(() => assertReadOnly('SELECT * INTO stolen FROM invoices'), /INTO/);
  assert.throws(
    () => assertReadOnly('SELECT 1 /* harmless */ ; DROP TABLE invoices'),
    /no semicolons/,
  );
  assert.throws(() => assertReadOnly('SELECT 1 -- note\nDELETE FROM invoices'), /DELETE/);
});

test('assertReadOnly ignores keywords inside literals and identifiers', () => {
  assert.doesNotThrow(() => assertReadOnly("SELECT 'delete update insert' AS note"));
  assert.doesNotThrow(() => assertReadOnly('SELECT "delete" FROM t'));
  assert.doesNotThrow(() => assertReadOnly('SELECT $tag$ delete $tag$ AS note'));
});

test('the API request is the one SELECT plus read_only: true', () => {
  const body = readOnlyBody(QUERY);
  assert.equal(body.read_only, true);
  assert.equal(body.query, QUERY);
  assert.throws(() => readOnlyBody('DELETE FROM invoices'), /only SELECT\/WITH/);
});

test('the document holds every metric for 1, 7 and 30 days plus one date', () => {
  const doc = buildMetrics(row(), NOW);
  assert.equal(doc.generated_at, '2026-11-05T13:15:00.000Z');
  for (const metric of [...COUNT_METRICS, ...MONEY_METRICS]) {
    for (const window of WINDOWS) {
      assert.equal(typeof doc[metric][window], 'number', `${metric}.${window}`);
    }
  }
  assert.equal(doc.member_pro_members.current, 12);
});

test('a nonzero count under 5 is reported as "<5"; zero stays 0', () => {
  assert.equal(bucketUnder5(0), 0);
  assert.equal(bucketUnder5(1), '<5');
  assert.equal(bucketUnder5(4), '<5');
  assert.equal(bucketUnder5(5), 5);
  assert.equal(bucketUnder5('3'), '<5');
  assert.equal(bucketUnder5('5'), 5);
});

// --- #807 HIGH regression: complete-day buckets + complementary suppression ---

test('a money total with fewer than 5 distinct customers is suppressed, even when large', () => {
  const doc = buildMetrics(
    row({
      gross_sales_days: [bucket(-1, 1, 9_999_999)],
      refund_days: [bucket(-1, 1, 9_999_999)],
    }),
    NOW,
  );
  assert.equal(doc.gross_sales_cents['1d'], '<5');
  assert.equal(doc.refunded_cents['1d'], '<5');
});

test('cohorts of 4 suppress and 5 release; a true zero stays zero', () => {
  const four = [];
  const five = [];
  for (let offset = -7; offset <= -1; offset += 1) {
    four.push(bucket(offset, 4, 100_000));
    five.push(bucket(offset, 5, 100_000));
  }
  assert.equal(buildMetrics(row({ gross_sales_days: four }), NOW).gross_sales_cents['7d'], '<5');
  assert.equal(buildMetrics(row({ gross_sales_days: five }), NOW).gross_sales_cents['7d'], 700_000);
  assert.equal(buildMetrics(row({ gross_sales_days: [] }), NOW).gross_sales_cents['7d'], 0);
});

test('many invoices from one customer are still one contributor', () => {
  // A day with 40 refunds from one bidder has cohort 1, so the large total,
  // the refund count and the sales total are all withheld.
  const doc = buildMetrics(
    row({
      refund_count_1d: 40,
      refund_days: [bucket(-1, 1, 4_000_000)],
      gross_sales_days: [bucket(-1, 1, 4_000_000)],
    }),
    NOW,
  );
  assert.equal(doc.refund_count['1d'], '<5');
  assert.equal(doc.refunded_cents['1d'], '<5');
  assert.equal(doc.gross_sales_cents['1d'], '<5');
});

test('a window is released only when every contributing day had a large cohort', () => {
  const days = [];
  for (let offset = -7; offset <= -1; offset += 1) days.push(bucket(offset, 6, 1_000));
  days.push(bucket(-8, 4, 9_000_000));
  const doc = buildMetrics(row({ gross_sales_days: days }), NOW);
  assert.equal(doc.gross_sales_cents['1d'], 1_000);
  assert.equal(doc.gross_sales_cents['7d'], 7_000);
  // The 30d window includes the 4-customer day, so it is withheld; with no
  // released 30d total, 30d−7d cannot isolate that day's amount.
  assert.equal(doc.gross_sales_cents['30d'], '<5');
});

test('overlapping windows never isolate a day by subtraction', () => {
  // Every day except -20 has a large cohort. 30d is withheld because of -20,
  // so 30d−7d is unavailable; every released value is a union of large days.
  const days = safeBuckets(1_000, 6).filter((b) => b.day !== isoDay(-20));
  days.push(bucket(-20, 1, 9_999_999));
  const doc = buildMetrics(row({ gross_sales_days: days }), NOW);
  assert.equal(doc.gross_sales_cents['7d'], 7_000);
  assert.equal(doc.gross_sales_cents['30d'], '<5');
});

test('complete-day buckets make same-day snapshots identical and exclude today', () => {
  const days = safeBuckets(1_000, 6);
  days.push(bucket(0, 1, 9_999_999)); // today is still in progress
  const morning = buildMetrics(row({ gross_sales_days: days }), new Date('2026-11-05T08:00:00Z'));
  const evening = buildMetrics(row({ gross_sales_days: days }), new Date('2026-11-05T23:59:59Z'));
  assert.equal(morning.gross_sales_cents['1d'], 1_000);
  assert.equal(morning.gross_sales_cents['7d'], 7_000);
  assert.equal(morning.gross_sales_cents['30d'], 30_000);
  assert.equal(evening.gross_sales_cents['1d'], morning.gross_sales_cents['1d']);
  assert.equal(evening.gross_sales_cents['7d'], morning.gross_sales_cents['7d']);
  assert.equal(evening.gross_sales_cents['30d'], morning.gross_sales_cents['30d']);
});

test('day buckets straddling the UTC cutoff land in the right window', () => {
  // The SQL buckets by (paid_at AT TIME ZONE 'UTC')::date; the pure model must
  // agree. Yesterday is in 1d; two days ago is only in 7d.
  const yesterday = buildMetrics(row({ gross_sales_days: [bucket(-1, 6, 1_000)] }), NOW);
  assert.equal(yesterday.gross_sales_cents['1d'], 1_000);
  const older = buildMetrics(row({ gross_sales_days: [bucket(-2, 6, 1_000)] }), NOW);
  assert.equal(older.gross_sales_cents['1d'], 0);
  assert.equal(older.gross_sales_cents['7d'], 1_000);
});

test('refund counts use the same complete-day cutoff as the amount', () => {
  const doc = buildMetrics(row({ refund_count_1d: 9, refund_days: [bucket(-1, 2, 500_000)] }), NOW);
  assert.equal(doc.refunded_cents['1d'], '<5');
  assert.equal(doc.refund_count['1d'], '<5');
});

test('member Pro windows and the current snapshot are separate', () => {
  const doc = buildMetrics(row({ member_pro_members_current: 2 }), NOW);
  assert.equal(doc.member_pro_members.current, '<5');
  assert.equal(doc.member_pro_members['30d'], 12);
});

test('the shape check accepts numbers, "<5" and the ISO date only', () => {
  const doc = buildMetrics(
    row({ active_users_1d: 2, gross_sales_days: [bucket(-1, 1, 500_000)] }),
    NOW,
  );
  assert.equal(doc.active_users['1d'], '<5');
  assert.equal(doc.gross_sales_cents['1d'], '<5');
  assert.doesNotThrow(() => assertMetricsShape(doc));
});

test('the shape check rejects a string, an id, null, an array or a bad date', () => {
  const doc = buildMetrics(row(), NOW);
  assert.throws(
    () => assertMetricsShape({ ...doc, active_users: { '1d': 'Braden' } }),
    /not a number/,
  );
  assert.throws(
    () =>
      assertMetricsShape({ ...doc, new_signups: { '1d': '00000000-0000-0000-0000-000000000000' } }),
    /not a number/,
  );
  assert.throws(() => assertMetricsShape({ ...doc, lots_sold: { '1d': null } }), /not a number/);
  assert.throws(() => assertMetricsShape({ ...doc, lots_sold: { '1d': [1] } }), /not a number/);
  assert.throws(() => assertMetricsShape({ ...doc, lots_sold: { '1d': -1 } }), /non-negative/);
  assert.throws(() => assertMetricsShape({ ...doc, lots_sold: { '1d': 1.5 } }), /non-negative/);
  assert.throws(() => assertMetricsShape({ ...doc, generated_at: 'yesterday' }), /ISO timestamp/);
});

test('malformed aggregate rows fail closed instead of becoming zeroes', () => {
  assert.throws(() => buildMetrics(row({ active_users_1d: null })), /non-negative integer/);
  assert.throws(() => buildMetrics(row({ active_users_1d: undefined })), /non-negative integer/);
  const missing = row();
  delete missing.new_signups_7d;
  assert.throws(() => buildMetrics(missing), /missing new_signups_7d/);
  assert.throws(() => buildMetrics(row({ active_users_1d: 'abc' })), /non-negative integer/);
  assert.throws(() => buildMetrics(row({ active_users_1d: ' 5' })), /non-negative integer/);
  assert.throws(() => buildMetrics(row({ active_users_1d: -1 })), /non-negative/);
  assert.throws(() => buildMetrics(row({ active_users_1d: 1.5 })), /non-negative/);
  assert.throws(
    () => buildMetrics(row({ active_users_1d: Number.MAX_SAFE_INTEGER + 2 })),
    /safe integer/,
  );
  assert.throws(() => buildMetrics(row({ active_users_1d: true })), /non-negative integer/);
  const missingDaily = row();
  delete missingDaily.gross_sales_days;
  assert.throws(() => buildMetrics(missingDaily), /missing gross_sales_days/);
  assert.throws(() => buildMetrics(row({ gross_sales_days: 'nope' })), /must be an array/);
  assert.throws(
    () =>
      buildMetrics(row({ gross_sales_days: [{ day: '2026-02-31', contributors: 6, amount: 1 }] })),
    /not a real date/,
  );
  assert.throws(
    () =>
      buildMetrics(row({ gross_sales_days: [{ day: isoDay(-1), contributors: 6, amount: -1 }] })),
    /non-negative/,
  );
  assert.throws(() => buildMetrics(row({ refund_days: [null] })), /bucket must be an object/);
});

test('explicitly valid numeric strings remain supported', () => {
  const doc = buildMetrics(
    row({
      active_bidders_1d: '7',
      gross_sales_days: [{ day: isoDay(-1), contributors: '5', amount: '4500' }],
    }),
    NOW,
  );
  assert.equal(doc.active_bidders['1d'], 7);
  assert.equal(doc.gross_sales_cents['1d'], 4500);
});

test('the query uses the event ledger and the entitlement predicate', () => {
  // Guard against a future refactor quietly reintroducing the semantics the
  // #807 review rejected.
  assert.match(QUERY, /lot_status_history/);
  assert.match(QUERY, /auction_status_history/);
  assert.match(QUERY, /operator_refund_ledger/);
  assert.match(QUERY, /current_period_end/);
  assert.match(QUERY, /watchlist/);
  // Money is bucketed into complete UTC days and windowed in JS; a rolling
  // now()-interval total on the ledger would reintroduce the #807 HIGH.
  assert.match(QUERY, /AT TIME ZONE 'UTC'/);
  assert.match(QUERY, /bounds\.today - 30/);
  assert.match(QUERY, /json_agg/);
  assert.doesNotMatch(QUERY, /gross_sales_cents_/);
  assert.doesNotMatch(QUERY, /refunded_cents_/);
  // MEDIUMs from the same review: refund→unsold relisting, auto-charges as
  // activity, and current-state-only Member Pro windows.
  assert.match(QUERY, /from_status IS DISTINCT FROM 'refunded'/);
  // Auto-charges are excluded by the append-only attempt log plus a bounded
  // timestamp skew, not fragile millisecond equality (RED TEAM at 3e09b41d).
  // Any auto_charge attempt counts: a webhook-recovered timeout has no success
  // row and no close paid_at (RED TEAM at ed981234).
  assert.match(QUERY, /ca\.source = 'auto_charge'/);
  assert.doesNotMatch(QUERY, /ca\.outcome = 'succeeded'/);
  assert.match(QUERY, /abs\(extract\(epoch FROM \(i\.paid_at - i\.last_auto_charge_at\)\)\) <= 60/);
  // Never-activated rows no longer count as a Member Pro activation.
  assert.match(QUERY, /created_at > now\(\) - interval '1 day' AND status <> 'none'/);
  assert.match(QUERY, /updated_at > now\(\) - interval '1 day'/);
});

test('the document is built from the allowlist, so unknown row fields are dropped', () => {
  const doc = buildMetrics(
    row({ bidder_email: 'someone@example.invalid', invoice_id: 'inv-1', note: 'free text' }),
    NOW,
  );
  const json = JSON.stringify(doc);
  assert.doesNotMatch(json, /example\.invalid|inv-1|free text/);
  assert.deepEqual(Object.keys(doc).sort(), [
    'active_bidders',
    'active_users',
    'auctions_run',
    'generated_at',
    'gross_sales_cents',
    'lots_listed',
    'lots_sold',
    'lots_unsold',
    'member_pro_members',
    'new_signups',
    'refund_count',
    'refunded_cents',
  ]);
});

// --- #807 re-check regressions (RED TEAM FAIL at 3e09b41d) -----------------

test('HIGH: a later ledger correction cannot move an already-published day', () => {
  // Day -10 is a releasable 5-customer day; it is published once, then a
  // manager override re-dates an extra 1,234 cents onto it.
  const days = safeBuckets().map((b) =>
    b.day === isoDay(-10) ? { ...bucket(-10, MIN_COHORT, 5_000), fingerprint: 111 } : b,
  );
  const first = buildMetrics(row({ gross_sales_days: days }), NOW);
  const ledger = publishableDays(row({ gross_sales_days: days }), NOW);

  const correctedDays = safeBuckets().map((b) =>
    b.day === isoDay(-10) ? { ...bucket(-10, MIN_COHORT, 6_234), fingerprint: 999 } : b,
  );
  const correctedRow = row({ gross_sales_days: correctedDays });

  // Same-day rebuild with the frozen ledger is byte-identical for money.
  const second = buildMetrics(correctedRow, NOW, { frozen: ledger.days });
  assert.deepEqual(second.gross_sales_cents, first.gross_sales_cents);
  assert.ok(!JSON.stringify(second).includes('6234'), 'published the correction');
  assert.ok(!JSON.stringify(second).includes('1234'), 'published the delta');
  assert.equal(
    publishableDays(correctedRow, NOW, { frozen: ledger.days }).days.gross_sales_days.find(
      (b) => b.day === isoDay(-10),
    ).amount,
    5_000,
    'the frozen ledger must keep the published amount',
  );

  // Consecutive-day snapshot: day -10 stays frozen, but its linked records
  // changed, so the run fails closed and withholds the newly completed day
  // instead of publishing a fresh total beside the retained one. The 1,234-cent
  // correction is still never published.
  const nextNow = new Date(NOW.getTime() + DAY_MS);
  const nextRow = row({
    gross_sales_days: [...correctedDays, { ...bucket(0, 6, 777), fingerprint: 333 }],
  });
  const frozen = buildMetrics(nextRow, nextNow, { frozen: ledger.days });
  const leaky = buildMetrics(nextRow, nextNow);
  assert.equal(frozen.gross_sales_cents['30d'], '<5');
  assert.equal(leaky.gross_sales_cents['30d'] - first.gross_sales_cents['30d'], 777 - 12 + 1_234);
  assert.ok(!JSON.stringify(frozen).includes('6234'));
  assert.ok(!JSON.stringify(frozen).includes('1234'));
});

test('HIGH: a withheld small-cohort day stays withheld after later corrections', () => {
  const build = (contributors) =>
    row({
      gross_sales_days: safeBuckets().map((b) =>
        b.day === isoDay(-3) ? bucket(-3, contributors, 999) : b,
      ),
    });
  const first = buildMetrics(build(4), NOW);
  assert.equal(first.gross_sales_cents['7d'], '<5');
  const ledger = publishableDays(build(4), NOW);
  assert.equal(
    ledger.days.gross_sales_days.find((b) => b.day === isoDay(-3)).amount,
    null,
    'a small cohort amount must never be written to the ledger',
  );

  // A later correction that makes the day look large cannot release it.
  const second = buildMetrics(build(6), NOW, { frozen: ledger.days });
  assert.equal(second.gross_sales_cents['7d'], '<5');
  assert.ok(!JSON.stringify(second).includes('999'));
});

test('MEDIUM: the frozen ledger fails closed when malformed', () => {
  assert.throws(() => parseFrozenDays({ gross_sales_days: 'nope' }), /must be an array/);
  assert.throws(
    () =>
      parseFrozenDays({ gross_sales_days: [{ day: '2026-13-01', contributors: 6, amount: 1 }] }),
    /real date/,
  );
  assert.throws(
    () =>
      parseFrozenDays({ gross_sales_days: [{ day: '2026-11-01', contributors: 6, amount: -1 }] }),
    /non-negative/,
  );
  assert.deepEqual(mergeFrozenDays([], []), []);
});

// --- #807 re-check regressions (RED TEAM FAIL at ed981234) -----------------

test('HIGH: the frozen ledger is required, and missing days abort publication', () => {
  // A ledger object must carry BOTH day arrays. A missing/null array used to
  // be treated as "no history", silently recomputing published money.
  assert.throws(() => parseFrozenDays({}), /missing gross_sales_days/);
  assert.throws(() => parseFrozenDays({ gross_sales_days: [] }), /missing refund_days/);
  assert.throws(
    () => parseFrozenDays({ gross_sales_days: [], refund_days: null }),
    /missing refund_days/,
  );
  // An explicit null still means "verified first initialization" only.
  const firstRun = parseFrozenDays(null);
  assert.deepEqual(firstRun.gross_sales_days, []);
  assert.deepEqual(firstRun.refund_days, []);
  assert.deepEqual(firstRun.released, { gross_sales_days: [], refund_days: [] });
  assert.deepEqual(firstRun.count_history, emptyCountHistoryFields().count_history);
  assert.deepEqual(firstRun.count_history_sizes, emptyCountHistoryFields().count_history_sizes);
  // A suppressed count is stored as null, not as an exact 1–4.
  assert.deepEqual(
    parseFrozenDays({
      gross_sales_days: [{ day: isoDay(-1), contributors: null, amount: null }],
      refund_days: [],
      released: { gross_sales_days: [], refund_days: [] },
      released_counts: { gross_sales_days: 0, refund_days: 0 },
      ...emptyCountHistoryFields(),
    }).gross_sales_days,
    [{ day: Date.UTC(2026, 10, 4) / DAY_MS, contributors: 0, amount: null, fingerprint: 0 }],
  );
  assert.throws(
    () =>
      parseFrozenDays({
        gross_sales_days: [{ day: isoDay(-1), contributors: null, amount: 5 }],
        refund_days: [],
        released: { gross_sales_days: [], refund_days: [] },
        released_counts: { gross_sales_days: 0, refund_days: 0 },
      }),
    /amount without contributors/,
  );
});

test('HIGH: a frozen ledger wins over a recomputed history, including the sidecar', () => {
  const published = publishableDays(
    row({
      gross_sales_days: safeBuckets().map((b) =>
        b.day === isoDay(-10) ? bucket(-10, 6, 5_000) : b,
      ),
    }),
    NOW,
  );
  const corrected = row({
    gross_sales_days: safeBuckets().map((b) => (b.day === isoDay(-10) ? bucket(-10, 6, 6_234) : b)),
  });
  const doc = buildMetrics(corrected, NOW, { frozen: published.days });
  assert.equal(doc.gross_sales_cents['30d'], 30 * 12 - 12 + 5_000);
  assert.ok(!JSON.stringify(doc).includes('6234'));
  const sidecar = publishableDays(corrected, NOW, { frozen: published.days });
  assert.equal(sidecar.days.gross_sales_days.find((b) => b.day === isoDay(-10)).amount, 5_000);
  // The workflow must never pass --first-run for an existing branch: the shell
  // body is checked by the source-guard in the workflow test below.
});

test('HIGH: gross and refunds cannot be differenced into a small residual cohort', () => {
  // Six gross customers, five of them fully refunded: the residual is one
  // person, so the refund amount must be withheld even though its own cohort
  // is exactly 5.
  const day = row({
    gross_sales_days: [bucket(-1, 6, 600_000)],
    refund_days: [bucket(-1, 5, 500_000)],
    gross_sales_contributors_1d: 6,
    refund_contributors_1d: 5,
    refund_count_1d: 5,
  });
  const doc = buildMetrics(day, NOW);
  assert.equal(doc.gross_sales_cents['1d'], 600_000);
  assert.equal(doc.refunded_cents['1d'], '<5');

  // A residual of five is a large-enough pooled cohort: release both.
  const spread = buildMetrics(
    row({
      gross_sales_days: [bucket(-1, 10, 1_000_000)],
      refund_days: [bucket(-1, 5, 400_000)],
      gross_sales_contributors_1d: 10,
      refund_contributors_1d: 5,
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(spread.gross_sales_cents['1d'], 1_000_000);
  assert.equal(spread.refunded_cents['1d'], 400_000);

  // Multi-day: the largest released gross day has six customers and five of
  // them are refunded on another day, leaving one person. Day-level checks
  // pass on both days, so the cross-day bound must withhold the refund.
  const windowDoc = buildMetrics(
    row({
      gross_sales_days: [bucket(-2, 6, 1_000_000), bucket(-1, 6, 600_000)],
      refund_days: [bucket(-2, 5, 400_000)],
      gross_sales_contributors_7d: 6,
      refund_contributors_7d: 5,
      refund_count_7d: 5,
    }),
    NOW,
  );
  assert.equal(windowDoc.gross_sales_cents['7d'], 1_600_000);
  assert.equal(windowDoc.refunded_cents['7d'], '<5');
});

test('MEDIUM: the published sidecar never exposes a 1–4 contributor count', () => {
  const ledger = publishableDays(
    row({
      gross_sales_days: [bucket(-2, 3, 999), bucket(-1, 6, 1_200)],
      refund_days: [bucket(-1, 4, 800)],
      refund_count_1d: 4,
    }),
    NOW,
  );
  const small = ledger.days.gross_sales_days.find((b) => b.day === isoDay(-2));
  assert.equal(small.contributors, null);
  assert.equal(small.amount, null);
  const large = ledger.days.gross_sales_days.find((b) => b.day === isoDay(-1));
  assert.equal(large.contributors, 6);
  assert.equal(large.amount, 1_200);
  const refund = ledger.days.refund_days.find((b) => b.day === isoDay(-1));
  assert.equal(refund.contributors, null);
  assert.equal(refund.amount, null);
  assert.ok(!JSON.stringify(ledger).includes('"contributors":3'));
  assert.ok(!JSON.stringify(ledger).includes('"contributors":4'));
});

test('MEDIUM: a complementary-suppressed refund stays suppressed in the next ledger', () => {
  const first = publishableDays(
    row({
      gross_sales_days: [bucket(-1, 6, 600_000)],
      refund_days: [bucket(-1, 5, 500_000)],
      gross_sales_contributors_1d: 6,
      refund_contributors_1d: 5,
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(first.days.refund_days[0].amount, null);
  const next = buildMetrics(
    row({
      gross_sales_days: [bucket(-1, 6, 600_000)],
      refund_days: [bucket(-1, 5, 500_000)],
      gross_sales_contributors_1d: 6,
      refund_contributors_1d: 5,
      refund_count_1d: 5,
    }),
    NOW,
    { frozen: first.days },
  );
  assert.equal(next.refunded_cents['1d'], '<5');
  assert.ok(!JSON.stringify(next).includes('500000'));
  // The pure helper leaves a large residual alone.
  const { refund } = suppressComplementary([bucket(-1, 10, 1)], [bucket(-1, 5, 1)]);
  assert.equal(refund[0].amount, 1);
});

test('HIGH: gross and refunds on DIFFERENT days cannot be differenced (sidecar included)', () => {
  // Six gross customers on one day, five of them refunded on another day. The
  // old same-date check published both day amounts in the sidecar, so the
  // remaining person's amount was recoverable by subtraction (RED TEAM at
  // da6ca2e1 HIGH 1).
  const linked = row({
    gross_sales_days: [bucket(-2, 6, 600_000)],
    refund_days: [bucket(-1, 5, 500_000)],
    gross_sales_contributors_1d: 6,
    refund_contributors_1d: 5,
    refund_count_1d: 5,
  });
  const doc = buildMetrics(linked, NOW);
  assert.equal(doc.gross_sales_cents['7d'], 600_000);
  assert.equal(doc.refunded_cents['7d'], '<5');

  const sidecar = publishableDays(linked, NOW);
  const refundDay = sidecar.days.refund_days.find((b) => b.day === isoDay(-1));
  assert.equal(refundDay.amount, null);
  // Gross may still publish; without the refund amount there is no safe
  // subtraction that yields the one remaining customer's amount.
  const grossDay = sidecar.days.gross_sales_days.find((b) => b.day === isoDay(-2));
  assert.equal(grossDay.amount, 600_000);
  assert.ok(!JSON.stringify(sidecar).includes('500000'));
});

test('HIGH: fresh contributor counts cannot unlock a frozen suppressed refund', () => {
  // First release: six gross customers, five refunded -> withheld.
  const first = publishableDays(
    row({
      gross_sales_days: [bucket(-1, 6, 600_000)],
      refund_days: [bucket(-1, 5, 500_000)],
      gross_sales_contributors_1d: 6,
      refund_contributors_1d: 5,
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(first.days.refund_days[0].amount, null);

  // A later read reports a much larger fresh window cohort (historical
  // backfill). The frozen days still say six and five, so the refund must stay
  // withheld in both artifacts (RED TEAM at da6ca2e1 HIGH 2).
  const backfilled = row({
    gross_sales_days: [bucket(-1, 6, 600_000)],
    refund_days: [bucket(-1, 5, 500_000)],
    gross_sales_contributors_1d: 40,
    refund_contributors_1d: 5,
    refund_count_1d: 5,
  });
  const doc = buildMetrics(backfilled, NOW, { frozen: first.days });
  assert.equal(doc.refunded_cents['1d'], '<5');
  assert.ok(!JSON.stringify(doc).includes('500000'));

  const sidecar = publishableDays(backfilled, NOW, { frozen: first.days });
  assert.equal(sidecar.days.refund_days[0].amount, null);
  assert.ok(!JSON.stringify(sidecar).includes('500000'));
});

test('MEDIUM: an auto-charge attempt does not hide a later counter payment', () => {
  // The query must count a genuine mark-paid settlement even when an earlier
  // automatic attempt exists, while still excluding auto-charge recovery.
  assert.match(QUERY, /ca\.source = 'offline_mark_paid'/);
  assert.match(QUERY, /ca\.source = 'auto_charge'/);
  assert.match(
    QUERY,
    /EXISTS \(\s*SELECT 1 FROM charge_attempts ca\s*WHERE ca\.invoice_id = i\.id\s*AND ca\.source = 'offline_mark_paid'/,
  );
});

test('HIGH: an unrelated larger gross day cannot authorize a small selectable pair', () => {
  // The attacker selects the six-customer gross day and the five-customer
  // refund day. A separate ten-customer day must not raise the bound (RED TEAM
  // at 08fa83f0 HIGH 1).
  const linked = row({
    gross_sales_days: [bucket(-3, 6, 6_234), bucket(-1, 10, 900_000)],
    refund_days: [bucket(-2, 5, 5_000)],
    refund_count_7d: 5,
  });
  const doc = buildMetrics(linked, NOW);
  assert.equal(doc.refunded_cents['7d'], '<5');
  const sidecar = publishableDays(linked, NOW);
  assert.equal(sidecar.days.refund_days.find((b) => b.day === isoDay(-2)).amount, null);
  assert.ok(!JSON.stringify(doc).includes('5000'));
  assert.ok(!JSON.stringify(sidecar).includes('5000'));
});

test('HIGH: an ever-released refund is remembered after re-suppression and aging', () => {
  // 10 gross customers, one 5-customer refund: residual 5, safe to release.
  const first = publishableDays(
    row({
      gross_sales_days: [bucket(-1, 10, 1_000_000)],
      refund_days: [bucket(-1, 5, 400_000)],
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(first.days.refund_days[0].amount, 400_000);
  assert.equal(first.days.released.refund_days.length, 1);

  // A second overlapping refund makes the pair unsafe; the new output
  // re-suppresses both, but the ever-released history keeps the first one.
  const secondRow = row({
    gross_sales_days: [bucket(-1, 10, 1_000_000)],
    refund_days: [bucket(-1, 5, 400_000), bucket(-2, 5, 400_000)],
    refund_count_7d: 10,
  });
  const second = publishableDays(secondRow, NOW, { frozen: first.days });
  assert.equal(
    second.days.refund_days.every((b) => b.amount === null),
    true,
  );
  assert.equal(second.days.released.refund_days.length, 1);

  // A third refund cannot become releasable by forgetting the first (RED TEAM
  // at 08fa83f0 HIGH 2).
  const thirdRow = row({
    gross_sales_days: [bucket(-1, 10, 1_000_000)],
    refund_days: [bucket(-1, 5, 400_000), bucket(-2, 5, 400_000), bucket(-3, 5, 400_000)],
    refund_count_7d: 15,
  });
  const third = publishableDays(thirdRow, NOW, { frozen: second.days });
  assert.equal(
    third.days.refund_days.every((b) => b.amount === null),
    true,
  );
  assert.equal(third.days.released.refund_days.length, 1);
});

test('HIGH: an expired bucket cannot authorize a current release in either artifact', () => {
  const current = row({
    gross_sales_days: [bucket(-1, 6, 6_234)],
    refund_days: [bucket(-1, 5, 5_000)],
    refund_count_1d: 5,
  });
  const frozen = withCountHistory({
    gross_sales_days: [],
    refund_days: [],
    released: {
      gross_sales_days: [{ day: isoDay(-31), contributors: 10, amount: 900_000, fingerprint: 111 }],
      refund_days: [],
    },
    released_counts: { gross_sales_days: 1, refund_days: 0 },
  });
  const doc = buildMetrics(current, NOW, { frozen });
  assert.equal(doc.refunded_cents['1d'], '<5');
  const sidecar = publishableDays(current, NOW, { frozen });
  assert.equal(sidecar.days.refund_days[0].amount, null);
});

// --- #807 re-check regressions (RED TEAM FAIL at 4f6eb4c7) -----------------

test('HIGH: a later gross day cannot expose an already-released refund', () => {
  // First release: ten gross customers with a five-customer refund -> the
  // residual five customers are safe, so the refund amount is published.
  const first = publishableDays(
    row({
      gross_sales_days: [bucket(-2, 10, 1_000_000)],
      refund_days: [bucket(-2, 5, 400_000)],
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(first.days.refund_days[0].amount, 400_000);
  assert.equal(first.days.released.refund_days.length, 1);

  // The five refunded customers repurchase alongside one new customer, giving
  // a new six-customer gross day. The retained refund is irrevocable, so a new
  // gross of 6,234 would reveal the remaining 1,234 cents by subtraction.
  const later = row({
    gross_sales_days: [bucket(-2, 10, 1_000_000), bucket(-1, 6, 6_234)],
    refund_days: [bucket(-2, 5, 400_000)],
    refund_count_1d: 5,
  });
  const second = publishableDays(later, NOW, { frozen: first.days });
  const newGross = second.days.gross_sales_days.find((b) => b.day === isoDay(-1));
  assert.equal(newGross.amount, null, 'the new gross must be withheld');
  assert.ok(!JSON.stringify(second).includes('6234'));

  const doc = buildMetrics(later, NOW, { frozen: first.days });
  assert.ok(!JSON.stringify(doc).includes('6234'));
  // A residual cohort of five or more stays safe.
  const safe = suppressComplementary([bucket(-1, 10, 1)], [], {
    gross_sales_days: [],
    refund_days: [bucket(-2, 5, 1)],
  });
  assert.equal(safe.gross[0].amount, 1);
});

test('HIGH: a payment-date repair cannot double-count or expose a remainder', () => {
  // Ten customers paid 10,234 cents on day -2; that day is published.
  const first = publishableDays(
    row({ gross_sales_days: [bucket(-2, 10, 10_234)], refund_days: [] }),
    NOW,
  );
  assert.equal(first.days.gross_sales_days.find((b) => b.day === isoDay(-2)).amount, 10_234);

  // Nine 1,000-cent payments are repaired onto a previously absent day, so the
  // old day falls to 1,234 and a new nine-customer day appears with 9,000.
  const repaired = row({
    gross_sales_days: [bucket(-2, 1, 1_234), bucket(-1, 9, 9_000)],
    refund_days: [],
  });
  const second = publishableDays(repaired, NOW, { frozen: first.days });
  assert.equal(
    second.days.gross_sales_days.find((b) => b.day === isoDay(-2)).amount,
    10_234,
    'the published day stays frozen',
  );
  assert.equal(
    second.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount,
    null,
    'the moved-in day is withheld',
  );
  assert.ok(!JSON.stringify(second).includes('9000'));

  const doc = buildMetrics(repaired, NOW, { frozen: first.days });
  assert.ok(!JSON.stringify(doc).includes('9000'));
  assert.ok(!JSON.stringify(doc).includes('1234'));
});

test('HIGH: a missing or corrupt release history fails closed', () => {
  const first = publishableDays(
    row({
      gross_sales_days: [bucket(-1, 10, 1_000_000)],
      refund_days: [bucket(-1, 5, 400_000)],
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(first.days.refund_days[0].amount, 400_000);

  // Deleting the history while published amounts remain must abort, not
  // reconstruct from the current buckets (RED TEAM at 4f6eb4c7 HIGH 3).
  const withoutHistory = {
    gross_sales_days: first.days.gross_sales_days,
    refund_days: first.days.refund_days,
  };
  assert.throws(
    () =>
      publishableDays(
        row({ gross_sales_days: [bucket(-1, 10, 1_000_000)], refund_days: [] }),
        NOW,
        { frozen: withoutHistory },
      ),
    /missing the released history/,
  );

  // A partial history (one array removed) also aborts.
  assert.throws(
    () =>
      publishableDays(
        row({ gross_sales_days: [bucket(-1, 10, 1_000_000)], refund_days: [] }),
        NOW,
        {
          frozen: { ...first.days, released: { gross_sales_days: [] } },
        },
      ),
    /released refund_days must be an array/,
  );

  // Removing one released day's movement fingerprint is a reset attempt too:
  // the day could not be re-checked, so it must abort (RED TEAM at 8fb74609
  // HIGH 1).
  assert.throws(
    () =>
      publishableDays(
        row({ gross_sales_days: [bucket(-1, 10, 1_000_000)], refund_days: [] }),
        NOW,
        {
          frozen: {
            ...first.days,
            released: {
              gross_sales_days: first.days.released.gross_sales_days.map((bucket) => {
                const copy = { ...bucket };
                delete copy.fingerprint;
                return copy;
              }),
              refund_days: first.days.released.refund_days,
            },
          },
        },
      ),
    /released gross_sales_days\.fingerprint/,
  );

  // A ledger whose every bucket is withheld may still keep an empty history,
  // but the history field itself is REQUIRED: only a verified first run may
  // omit it (RED TEAM at cee12a06 HIGH 2).
  const withheld = publishableDays(
    row({ gross_sales_days: [bucket(-1, 4, 999)], refund_days: [] }),
    NOW,
  );
  assert.throws(
    () =>
      publishableDays(row({ gross_sales_days: [bucket(-1, 4, 999)], refund_days: [] }), NOW, {
        frozen: {
          gross_sales_days: withheld.days.gross_sales_days,
          refund_days: withheld.days.refund_days,
        },
      }),
    /missing the released history/,
  );
  const again = publishableDays(
    row({ gross_sales_days: [bucket(-1, 4, 999)], refund_days: [] }),
    NOW,
    {
      frozen: withCountHistory({
        gross_sales_days: withheld.days.gross_sales_days,
        refund_days: withheld.days.refund_days,
        released: { gross_sales_days: [], refund_days: [] },
        released_counts: { gross_sales_days: 0, refund_days: 0 },
      }),
    },
  );
  assert.equal(again.days.released.gross_sales_days.length, 0);
  assert.deepEqual(again.days.released_counts, { gross_sales_days: 0, refund_days: 0 });
});

// --- #807 re-check regressions (RED TEAM FAIL at cee12a06) -----------------

function fpBucket(offset, contributors, amount, fingerprint) {
  return { ...bucket(offset, contributors, amount), fingerprint };
}

test('HIGH: vanished, fully moved or offsetting records withhold every new day', () => {
  const first = publishableDays(row({ gross_sales_days: [fpBucket(-2, 10, 10_234, 111)] }), NOW);

  // 1. The whole source day vanishes and nine payments land on a new day.
  const vanished = row({ gross_sales_days: [fpBucket(-1, 9, 9_000, 222)] });
  const vanishedSidecar = publishableDays(vanished, NOW, { frozen: first.days });
  assert.equal(
    vanishedSidecar.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount,
    null,
    'the moved-in day must be withheld when the source vanished',
  );
  assert.ok(!JSON.stringify(vanishedSidecar).includes('9000'));
  assert.ok(!JSON.stringify(buildMetrics(vanished, NOW, { frozen: first.days })).includes('9000'));

  // 2. All ten move to one date: same aggregate, different linked records. The
  // total must not be counted twice across the retained days.
  const moved = row({ gross_sales_days: [fpBucket(-1, 10, 10_234, 333)] });
  const movedSidecar = publishableDays(moved, NOW, { frozen: first.days });
  assert.equal(movedSidecar.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.equal(movedSidecar.days.gross_sales_days.find((b) => b.day === isoDay(-2)).amount, 10_234);
  // The withheld new day makes the window unknowable; it can never be summed
  // with the retained day into a double count.
  assert.equal(buildMetrics(moved, NOW, { frozen: first.days }).gross_sales_cents['30d'], '<5');
  assert.ok(!JSON.stringify(movedSidecar).includes('20468'));

  // 3. An offsetting arrival keeps the source aggregate identical; only the
  // record fingerprint changes, and a new day would otherwise publish it.
  const offset = row({
    gross_sales_days: [fpBucket(-2, 10, 10_234, 999), fpBucket(-1, 5, 5_000, 444)],
  });
  const offsetSidecar = publishableDays(offset, NOW, { frozen: first.days });
  assert.equal(
    offsetSidecar.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount,
    null,
    'an offsetting arrival must not unlock a new day',
  );
  assert.ok(!JSON.stringify(offsetSidecar).includes('5000'));
});

test('HIGH: an aged-out frozen day is not movement, but a backfilled day is', () => {
  const first = publishableDays(
    row({ gross_sales_days: [fpBucket(-30, 10, 10_000, 111), fpBucket(-1, 6, 600, 222)] }),
    NOW,
  );
  const nextNow = new Date(NOW.getTime() + DAY_MS);
  // Day -30 has left the 30-day query horizon; day -1 is unchanged and day 0 is
  // the normally newly-completed day.
  const nextRow = row({
    gross_sales_days: [
      fpBucket(-30, 10, 10_000, 111),
      fpBucket(-1, 6, 600, 222),
      fpBucket(0, 6, 777, 333),
    ],
  });
  const next = publishableDays(nextRow, nextNow, { frozen: first.days });
  assert.equal(next.days.gross_sales_days.find((b) => b.day === isoDay(0)).amount, 777);

  // A new day at or before the newest published day is a backfill/repair, so
  // the normally new day is withheld too.
  const backfilled = row({
    gross_sales_days: [
      fpBucket(-30, 10, 10_000, 111),
      fpBucket(-29, 6, 600, 555),
      fpBucket(-1, 6, 600, 222),
      fpBucket(0, 6, 777, 333),
    ],
  });
  const backfillSidecar = publishableDays(backfilled, nextNow, { frozen: first.days });
  assert.equal(backfillSidecar.days.gross_sales_days.find((b) => b.day === isoDay(0)).amount, null);
});

test('HIGH: release history deleted or emptied after age-out fails closed', () => {
  const first = publishableDays(
    row({
      gross_sales_days: [fpBucket(-1, 10, 1_000_000, 111)],
      refund_days: [fpBucket(-1, 5, 400_000, 222)],
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(first.days.released.refund_days.length, 1);
  const aged = withCountHistory({
    gross_sales_days: [],
    refund_days: [],
    released: first.days.released,
    released_counts: first.days.released_counts,
  });

  // Intact aged-out history still withholds a new gross day that would expose
  // the already-released refund.
  const overlapping = row({ gross_sales_days: [fpBucket(-1, 6, 600, 333)] });
  const safe = publishableDays(overlapping, NOW, { frozen: aged });
  assert.equal(safe.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);

  // Deleting the whole history after age-out is no longer accepted.
  assert.throws(
    () =>
      publishableDays(overlapping, NOW, {
        frozen: { gross_sales_days: [], refund_days: [] },
      }),
    /missing the released history/,
  );
  // Emptying the arrays while keeping the recorded counts is caught too.
  assert.throws(
    () =>
      publishableDays(overlapping, NOW, {
        frozen: {
          gross_sales_days: [],
          refund_days: [],
          released: { gross_sales_days: [], refund_days: [] },
          released_counts: first.days.released_counts,
        },
      }),
    /history shrank/,
  );
});

// --- #807 re-check regressions (RED TEAM FAIL at 77941b64) -----------------

test('the query includes ever-released days so aged-out movement stays visible', () => {
  const sql = buildQuery([isoDay(-40), isoDay(-2)]);
  assert.ok(sql.includes(`'${isoDay(-40)}'`));
  assert.ok(sql.includes(`'${isoDay(-2)}'`));
  assert.doesNotThrow(() => assertReadOnly(sql));
  assert.throws(() => buildQuery(['2026-02-31']), /not a real date/);
  assert.throws(() => buildQuery(["2026-01-01' OR '1'='1"]), /YYYY-MM-DD/);
  assert.ok(QUERY.includes('ARRAY[]::date[]'));
});

test('HIGH: a withheld refund leaves no amount-derived fingerprint', () => {
  const build = (amount, fingerprint) =>
    publishableDays(
      row({
        gross_sales_days: [bucket(-2, 10, 1_000_000)],
        refund_days: [{ day: isoDay(-1), contributors: 1, amount, fingerprint }],
        refund_count_1d: 1,
      }),
      NOW,
    );
  const small = build(500_000, 123);
  const other = build(900_000, 456);
  assert.equal(small.days.refund_days[0].amount, null);
  assert.equal(small.days.refund_days[0].fingerprint, null);
  // Varying only the withheld amount leaves the published artifacts identical,
  // so a known invoice id cannot brute-force the amount from a stable hash.
  assert.deepEqual(small.days.refund_days, other.days.refund_days);
  assert.ok(!JSON.stringify(small).includes('500000'));
  assert.ok(!JSON.stringify(small).includes('900000'));

  // A released amount is public, so its movement evidence is safe to publish.
  const released = publishableDays(
    row({
      gross_sales_days: [bucket(-2, 20, 1_000_000)],
      refund_days: [{ day: isoDay(-1), contributors: 5, amount: 400_000, fingerprint: 777 }],
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(released.days.refund_days[0].amount, 400_000);
  assert.equal(released.days.refund_days[0].fingerprint, 777);
});

test('HIGH: a growing source total cannot hide moved records', () => {
  const first = publishableDays(
    row({ gross_sales_days: [fpBucket(-2, 10, 10_234, 111)], refund_days: [] }),
    NOW,
  );
  // Nine records move out while nine new records land on the old day: the old
  // total grows and its cohort does not shrink, which used to bypass the
  // movement check (RED TEAM at 77941b64 HIGH 2).
  const grown = row({
    gross_sales_days: [fpBucket(-2, 10, 11_234, 999), fpBucket(-1, 9, 9_000, 222)],
    refund_days: [],
  });
  const ledger = publishableDays(grown, NOW, { frozen: first.days });
  assert.equal(ledger.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.ok(!JSON.stringify(ledger).includes('9000'));
  assert.ok(!JSON.stringify(buildMetrics(grown, NOW, { frozen: first.days })).includes('9000'));

  // The evidence is immutable: a corrected released day keeps failing closed
  // until its original records are restored (RED TEAM at 8fb74609 HIGH 1).
  // The already-tainted day stays withheld and the next day cannot publish,
  // because a re-baseline would let the moved 9,000-cent subset be subtracted
  // from the retained 10,234 to recover the 1,234 remainder.
  const nextNow = new Date(NOW.getTime() + DAY_MS);
  const settled = row({
    gross_sales_days: [
      fpBucket(-2, 10, 11_234, 999),
      fpBucket(-1, 9, 9_000, 222),
      fpBucket(0, 6, 777, 333),
    ],
    refund_days: [],
  });
  const settledLedger = publishableDays(settled, nextNow, { frozen: ledger.days });
  assert.equal(settledLedger.days.gross_sales_days.find((b) => b.day === isoDay(0)).amount, null);
  assert.equal(settledLedger.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.ok(!JSON.stringify(settledLedger).includes('777'));
  assert.equal(
    settledLedger.days.released.gross_sales_days.find((b) => b.day === isoDay(-2)).fingerprint,
    111,
    'the retained release keeps its original evidence',
  );

  // Same rule for the monetary refund series.
  const firstRefund = publishableDays(
    row({
      gross_sales_days: [bucket(-3, 40, 5_000_000)],
      refund_days: [fpBucket(-2, 10, 10_234, 111)],
      refund_count_1d: 10,
    }),
    NOW,
  );
  assert.equal(firstRefund.days.refund_days.find((b) => b.day === isoDay(-2)).amount, 10_234);
  const grownRefund = row({
    gross_sales_days: [bucket(-3, 40, 5_000_000)],
    refund_days: [fpBucket(-2, 10, 11_234, 999), fpBucket(-1, 9, 9_000, 222)],
    refund_count_7d: 19,
  });
  const refundLedger = publishableDays(grownRefund, NOW, { frozen: firstRefund.days });
  assert.equal(refundLedger.days.refund_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.ok(!JSON.stringify(refundLedger).includes('9000'));
});

test('HIGH: movement is detected after a released day ages out', () => {
  const releasedDay = new Date(NOW.getTime() - 20 * DAY_MS).toISOString().slice(0, 10);
  const laterNow = new Date(NOW.getTime() + 20 * DAY_MS);
  // At `laterNow` the released day is 40 days old (outside the 30-day window).
  // buildQuery inlines released days, so the fresh row still returns it.
  const newDay = new Date(laterNow.getTime() - DAY_MS).toISOString().slice(0, 10);
  const first = publishableDays(
    row({
      gross_sales_days: [{ day: releasedDay, contributors: 10, amount: 10_234, fingerprint: 111 }],
    }),
    NOW,
  );
  const moved = row({
    gross_sales_days: [
      { day: releasedDay, contributors: 1, amount: 1_234, fingerprint: 999 },
      { day: newDay, contributors: 9, amount: 9_000, fingerprint: 222 },
    ],
  });
  const ledger = publishableDays(moved, laterNow, { frozen: first.days });
  assert.equal(ledger.days.gross_sales_days.find((b) => b.day === newDay).amount, null);
  assert.ok(!JSON.stringify(ledger).includes('9000'));

  // The aged-out source keeps its original evidence, so the following day
  // cannot publish either: an aged-out day is still subtractable from the
  // retained release (RED TEAM at 8fb74609 HIGH 1).
  const nextLater = new Date(laterNow.getTime() + DAY_MS);
  const nextNewDay = new Date(nextLater.getTime() - DAY_MS).toISOString().slice(0, 10);
  const settled = row({
    gross_sales_days: [
      { day: releasedDay, contributors: 1, amount: 1_234, fingerprint: 999 },
      { day: newDay, contributors: 9, amount: 9_000, fingerprint: 222 },
      { day: nextNewDay, contributors: 6, amount: 777, fingerprint: 333 },
    ],
  });
  const settledLedger = publishableDays(settled, nextLater, { frozen: ledger.days });
  assert.equal(settledLedger.days.gross_sales_days.find((b) => b.day === nextNewDay).amount, null);
  assert.equal(settledLedger.days.gross_sales_days.find((b) => b.day === newDay).amount, null);
  assert.ok(!JSON.stringify(settledLedger).includes('777'));
  assert.equal(
    settledLedger.days.released.gross_sales_days.find((b) => b.day === releasedDay).fingerprint,
    111,
  );
});

test('HIGH: multi-step movement cannot re-baseline a released day', () => {
  const first = publishableDays(row({ gross_sales_days: [fpBucket(-3, 10, 10_234, 111)] }), NOW);
  const releasedFingerprint = (ledger) =>
    ledger.days.released.gross_sales_days.find((b) => b.day === isoDay(-3)).fingerprint;

  // Path A: nine records leave for a day that has not completed yet (absent
  // from the fresh row), then land on a later completed day. If the release
  // evidence were re-baselined in between, the later 9,000 would publish and
  // 10,234 - 9,000 would reveal the 1,234 remainder.
  const partial = row({ gross_sales_days: [fpBucket(-3, 1, 1_234, 999)] });
  const firstMove = publishableDays(partial, NOW, { frozen: first.days });
  assert.equal(releasedFingerprint(firstMove), 111);
  const appeared = row({
    gross_sales_days: [fpBucket(-3, 1, 1_234, 999), fpBucket(-1, 9, 9_000, 222)],
  });
  const second = publishableDays(appeared, NOW, { frozen: firstMove.days });
  assert.equal(second.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.ok(!JSON.stringify(second).includes('9000'));
  assert.ok(!JSON.stringify(second).includes('1234'));
  assert.equal(releasedFingerprint(second), 111, 'the release keeps its original evidence');
  const doc = buildMetrics(appeared, NOW, { frozen: firstMove.days });
  assert.equal(doc.gross_sales_cents['30d'], '<5');
  assert.ok(!JSON.stringify(doc).includes('9000'));
  assert.ok(!JSON.stringify(doc).includes('1234'));

  // Path B: the same subset first lands on a completed day that is withheld,
  // then moves again. The already-withheld intermediate day must not launder
  // the evidence.
  const intermediate = row({
    gross_sales_days: [fpBucket(-3, 1, 1_234, 999), fpBucket(-2, 9, 9_000, 222)],
  });
  const held = publishableDays(intermediate, NOW, { frozen: first.days });
  assert.equal(held.days.gross_sales_days.find((b) => b.day === isoDay(-2)).amount, null);
  const later = row({
    gross_sales_days: [fpBucket(-3, 1, 1_234, 999), fpBucket(-1, 9, 9_000, 222)],
  });
  const after = publishableDays(later, NOW, { frozen: held.days });
  assert.equal(after.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.ok(!JSON.stringify(after).includes('9000'));
  assert.equal(releasedFingerprint(after), 111);
});

test('HIGH: a corrected withheld amount is not recoverable from retained evidence', () => {
  const first = publishableDays(row({ gross_sales_days: [fpBucket(-3, 10, 10_234, 111)] }), NOW);
  const correctedRow = (amount, fingerprint, contributors) =>
    row({
      gross_sales_days: [
        fpBucket(-3, contributors, amount, fingerprint),
        fpBucket(-1, 9, 9_000, 222),
      ],
    });
  const a = publishableDays(correctedRow(1_234, 999, 1), NOW, { frozen: first.days });
  const b = publishableDays(correctedRow(2_345, 555, 1), NOW, { frozen: first.days });

  // Varying the hidden corrected amount (and the fingerprint derived from it)
  // must leave every consumer-readable artifact byte-identical: no bounded
  // guess can recover the withheld 1–4 cohort amount from a known invoice id.
  assert.deepEqual(a.days, b.days);
  assert.ok(!JSON.stringify(a).includes('1234'));
  assert.ok(!JSON.stringify(a).includes('2345'));
  assert.ok(!JSON.stringify(a).includes('999'));
  assert.ok(!JSON.stringify(a).includes('555'));
  assert.equal(
    a.days.released.gross_sales_days.find((bucket) => bucket.day === isoDay(-3)).fingerprint,
    111,
    'the retained release keeps the fingerprint from when the amount was public',
  );

  const docA = buildMetrics(correctedRow(1_234, 999, 1), NOW, { frozen: first.days });
  const docB = buildMetrics(correctedRow(2_345, 555, 1), NOW, { frozen: first.days });
  assert.deepEqual(docA, docB);
  assert.ok(!JSON.stringify(docA).includes('1234'));
  assert.ok(!JSON.stringify(docA).includes('2345'));

  // The refund series has the same rule: a released refund day keeps the
  // fingerprint from when its amount was public, and correcting it to one
  // customer must not publish a fresh amount-derived fingerprint.
  const firstRefund = publishableDays(
    row({
      gross_sales_days: [bucket(-3, 40, 5_000_000)],
      refund_days: [fpBucket(-2, 5, 400_000, 777)],
      refund_count_1d: 5,
    }),
    NOW,
  );
  assert.equal(
    firstRefund.days.refund_days.find((bucket) => bucket.day === isoDay(-2)).amount,
    400_000,
  );
  const correctedRefund = (amount, fingerprint) =>
    publishableDays(
      row({
        gross_sales_days: [bucket(-3, 40, 5_000_000)],
        refund_days: [fpBucket(-2, 1, amount, fingerprint)],
        refund_count_1d: 1,
      }),
      NOW,
      { frozen: firstRefund.days },
    );
  const refundA = correctedRefund(1_234, 999);
  const refundB = correctedRefund(2_345, 555);
  assert.deepEqual(refundA.days, refundB.days);
  assert.ok(!JSON.stringify(refundA).includes('1234'));
  assert.ok(!JSON.stringify(refundA).includes('2345'));
  assert.equal(
    refundA.days.released.refund_days.find((bucket) => bucket.day === isoDay(-2)).fingerprint,
    777,
  );
});

test('the movement fingerprints never hash an amount', () => {
  // Gross evidence hashes invoice ids; refund evidence hashes invoice + refund
  // timestamp. Hashing face_cents/total_cents let a known id brute-force a
  // corrected/withheld amount (RED TEAM at 8fb74609 HIGH 2).
  assert.ok(!QUERY.includes('face_cents::text'));
  assert.ok(!QUERY.includes('total_cents::text'));
  assert.match(QUERY, /hashtext\(\s*invoice_id::text/);
});

test('HIGH: a re-suppressed released day still provides movement evidence', () => {
  const frozen = withCountHistory({
    gross_sales_days: [{ day: isoDay(-2), contributors: 10, amount: null, fingerprint: null }],
    refund_days: [],
    released: {
      gross_sales_days: [{ day: isoDay(-2), contributors: 10, amount: 10_000, fingerprint: 111 }],
      refund_days: [],
    },
    released_counts: { gross_sales_days: 1, refund_days: 0 },
  });
  const moved = row({
    gross_sales_days: [fpBucket(-2, 1, 1_000, 999), fpBucket(-1, 9, 9_000, 222)],
    refund_days: [],
  });
  const ledger = publishableDays(moved, NOW, { frozen });
  assert.equal(ledger.days.gross_sales_days.find((b) => b.day === isoDay(-1)).amount, null);
  assert.ok(!JSON.stringify(ledger).includes('9000'));
});

test('MEDIUM: a refund count uses the cohort of the same fresh records', () => {
  // 40 invoices from one customer: the fresh cohort is what must gate the
  // count, not the frozen monetary cohort from an earlier release.
  const oneCustomer = buildMetrics(
    row({
      refund_count_1d: 40,
      refund_contributors_1d: 1,
      gross_sales_days: [bucket(-1, 40, 4_000_000)],
      refund_days: [bucket(-1, 1, 500_000)],
    }),
    NOW,
  );
  assert.equal(oneCustomer.refund_count['1d'], '<5');
  const fiveCustomers = buildMetrics(
    row({
      refund_count_1d: 7,
      refund_contributors_1d: 5,
      gross_sales_days: [bucket(-1, 20, 2_000_000)],
      refund_days: [bucket(-1, 5, 500_000)],
    }),
    NOW,
  );
  assert.equal(fiveCustomers.refund_count['1d'], 7);
});

// --- #807 re-check regressions (RED TEAM FAIL at d1cc6545) -----------------

test('HIGH: deleting the published branch cannot reset disclosure history', () => {
  // 1. A 10-customer gross day and a 5-customer refund day are published once.
  const first = publishableDays(
    row({
      gross_sales_days: [fpBucket(-1, 10, 5_000, 111)],
      refund_days: [fpBucket(-1, 5, 2_000, 222)],
      refund_count_1d: 5,
      refund_contributors_1d: 5,
    }),
    NOW,
  );
  const publicArtifact = buildMetrics(
    row({
      gross_sales_days: [fpBucket(-1, 10, 5_000, 111)],
      refund_days: [fpBucket(-1, 5, 2_000, 222)],
      refund_count_1d: 5,
      refund_contributors_1d: 5,
    }),
    NOW,
  );
  assert.equal(publicArtifact.gross_sales_cents['1d'], 5_000);
  assert.equal(publicArtifact.refunded_cents['1d'], 2_000);
  const retained = JSON.stringify(publicArtifact);

  // 2. The consumer branch is deleted; the durable history survives.
  assert.equal(decideLedgerSource({ publishedExists: false, historyExists: true }), 'frozen');

  // 3. The records are corrected down to a 1-person cohort on that same day.
  //    Re-enabling must keep the old disclosure and publish no reduced total:
  //    retained minus the new aggregate would otherwise expose the correction.
  const corrected = row({
    gross_sales_days: [fpBucket(-1, 1, 1_234, 999)],
    refund_days: [fpBucket(-1, 1, 777, 888)],
    refund_count_1d: 1,
    refund_contributors_1d: 1,
  });
  const rebuilt = buildMetrics(corrected, NOW, { frozen: first.days });
  assert.equal(rebuilt.gross_sales_cents['1d'], 5_000);
  assert.equal(rebuilt.refunded_cents['1d'], 2_000);
  const rebuiltLedger = publishableDays(corrected, NOW, { frozen: first.days });
  assert.equal(rebuiltLedger.days.gross_sales_days[0].amount, 5_000);
  assert.equal(rebuiltLedger.days.refund_days[0].amount, 2_000);
  assert.ok(!JSON.stringify(rebuilt).includes('1234'));
  assert.ok(!JSON.stringify(rebuilt).includes('777'));
  assert.ok(!JSON.stringify(rebuiltLedger).includes('1234'));
  assert.ok(!JSON.stringify(rebuiltLedger).includes('777'));

  // 4. Losing the durable ledger too is NOT a first run. Even when the
  //    published branch is also gone, a retained artifact may still exist, so
  //    the run aborts unless a human explicitly confirms nothing was published.
  assert.throws(
    () => decideLedgerSource({ publishedExists: false, historyExists: false }),
    /refusing to initialize/,
  );
  // A published branch without its history is an inconsistent state.
  assert.throws(
    () => decideLedgerSource({ publishedExists: true, historyExists: false }),
    /durable disclosure history is missing/,
  );
  // Only the explicit confirmation starts a new history.
  assert.equal(
    decideLedgerSource({ publishedExists: false, historyExists: false, confirmedFirstRun: true }),
    'first-run',
  );
  assert.ok(retained.includes('5000'), 'the retained public artifact still shows the disclosure');
});

test('MEDIUM: nested count windows cannot be differenced into a 1-4 person cohort', () => {
  // 10 signups in 1d, 11 in 7d, 11 in 30d: each cell is releasable on its own,
  // but 7d-1d and 30d-1d are one-person remainders.
  const nested = buildMetrics(
    row({ new_signups_1d: 10, new_signups_7d: 11, new_signups_30d: 11 }),
    NOW,
  );
  assert.equal(nested.new_signups['1d'], 10);
  assert.equal(nested.new_signups['7d'], '<5');
  assert.equal(nested.new_signups['30d'], '<5');

  // Refund counts follow the same rule.
  const refunds = buildMetrics(
    row({
      refund_count_1d: 10,
      refund_count_7d: 11,
      refund_count_30d: 11,
      refund_contributors_1d: 10,
      refund_contributors_7d: 11,
      refund_contributors_30d: 11,
    }),
    NOW,
  );
  assert.equal(refunds.refund_count['1d'], 10);
  assert.equal(refunds.refund_count['7d'], '<5');
  assert.equal(refunds.refund_count['30d'], '<5');

  // Differences of 5 or more are large enough to publish.
  const safe = buildMetrics(
    row({ new_signups_1d: 10, new_signups_7d: 15, new_signups_30d: 20 }),
    NOW,
  );
  assert.deepEqual(safe.new_signups, { '1d': 10, '7d': 15, '30d': 20 });

  // A zero difference (nothing new) reveals nobody and stays publishable.
  const flat = buildMetrics(
    row({ new_signups_1d: 10, new_signups_7d: 10, new_signups_30d: 10 }),
    NOW,
  );
  assert.deepEqual(flat.new_signups, { '1d': 10, '7d': 10, '30d': 10 });
  assert.deepEqual(suppressNestedCounts({ '1d': 10, '7d': 12, '30d': 20 }), {
    '1d': 10,
    '7d': '<5',
    '30d': 20,
  });
});

// --- #822 count release history (RED TEAM #807 PASS at c6bebdda) -----------

function countHistoryFields(overrides = {}, day = isoDay(-1)) {
  const fields = emptyCountHistoryFields();
  for (const [key, values] of Object.entries(overrides)) {
    fields.count_history[key] = [...values].sort((a, b) => a - b).map((value) => ({ day, value }));
    fields.count_history_sizes[key] = values.length;
  }
  return fields;
}

function frozenLedger(overrides = {}) {
  return {
    gross_sales_days: [],
    refund_days: [],
    released: { gross_sales_days: [], refund_days: [] },
    released_counts: { gross_sales_days: 0, refund_days: 0 },
    ...countHistoryFields(),
    ...overrides,
  };
}

test('HIGH (#822): a count that moved by 1-4 since it was published is withheld', () => {
  // retained 7d=10, then 7d=11: the one-person difference is the disclosure.
  const frozen = frozenLedger({ ...countHistoryFields({ new_signups_7d: [10] }) });
  const near = buildMetrics(
    row({ new_signups_1d: 11, new_signups_7d: 11, new_signups_30d: 11 }),
    NOW,
    { frozen },
  );
  assert.equal(near.new_signups['7d'], '<5');

  // The withheld value never enters the ledger.
  const ledger = publishableDays(
    row({ new_signups_1d: 11, new_signups_7d: 11, new_signups_30d: 11 }),
    NOW,
    { frozen },
  );
  assert.deepEqual(ledger.days.count_history.new_signups_7d, [{ day: isoDay(-1), value: 10 }]);

  // A difference of five is a large enough cohort to publish.
  const far = buildMetrics(
    row({ new_signups_1d: 15, new_signups_7d: 15, new_signups_30d: 15 }),
    NOW,
    { frozen },
  );
  assert.equal(far.new_signups['7d'], 15);
  const farLedger = publishableDays(
    row({ new_signups_1d: 15, new_signups_7d: 15, new_signups_30d: 15 }),
    NOW,
    { frozen },
  );
  assert.deepEqual(farLedger.days.count_history.new_signups_7d, [
    { day: isoDay(-1), value: 10 },
    { day: isoDay(0), value: 15 },
  ]);

  // The same number again reveals nobody.
  const same = buildMetrics(
    row({ new_signups_1d: 10, new_signups_7d: 10, new_signups_30d: 10 }),
    NOW,
    { frozen },
  );
  assert.equal(same.new_signups['7d'], 10);
});

test('HIGH (#822): a count is compared against every earlier released value, not just the last', () => {
  const frozen = frozenLedger({ ...countHistoryFields({ new_signups_7d: [10, 20] }) });
  // 12 is eight away from the most recent value but only two from the first.
  const doc = buildMetrics(
    row({ new_signups_1d: 12, new_signups_7d: 12, new_signups_30d: 12 }),
    NOW,
    { frozen },
  );
  assert.equal(doc.new_signups['7d'], '<5');
});

test('HIGH (#822): an expiring or corrected count that drops by 1-4 is withheld', () => {
  for (const [previous, current] of [
    [14, 12],
    [9, 6],
  ]) {
    const frozen = frozenLedger({ ...countHistoryFields({ new_signups_7d: [previous] }) });
    const doc = buildMetrics(
      row({ new_signups_1d: current, new_signups_7d: current, new_signups_30d: current }),
      NOW,
      { frozen },
    );
    assert.equal(doc.new_signups['7d'], '<5', `${previous} -> ${current} must be withheld`);
  }

  // Restoring the published number reveals nothing new and is safe again.
  const restored = frozenLedger({ ...countHistoryFields({ new_signups_7d: [10] }) });
  const doc = buildMetrics(
    row({ new_signups_1d: 10, new_signups_7d: 10, new_signups_30d: 10 }),
    NOW,
    { frozen: restored },
  );
  assert.equal(doc.new_signups['7d'], 10);
});

test('HIGH (#822): nested windows are compared across releases too', () => {
  // Yesterday's 1d count (one day: two days ago) is inside today's 7d window.
  // Publishing 7d=12 against the retained 1d=10 would reveal a two-person
  // cohort, even though the cells are different windows.
  const frozen = frozenLedger({ ...countHistoryFields({ new_signups_1d: [10] }, isoDay(-1)) });
  const doc = buildMetrics(
    row({ new_signups_1d: 12, new_signups_7d: 12, new_signups_30d: 12 }),
    NOW,
    { frozen },
  );
  assert.equal(doc.new_signups['7d'], '<5');

  // A five-person remainder is large enough to publish.
  const safe = buildMetrics(
    row({ new_signups_1d: 15, new_signups_7d: 15, new_signups_30d: 15 }),
    NOW,
    { frozen },
  );
  assert.equal(safe.new_signups['7d'], 15);

  // A window that does NOT contain the retained one is not a cohort
  // difference: yesterday's 7d ends before today's 1d day, so both stay.
  const disjoint = frozenLedger({ ...countHistoryFields({ new_signups_7d: [10] }, isoDay(-1)) });
  const other = buildMetrics(
    row({ new_signups_1d: 12, new_signups_7d: 12, new_signups_30d: 12 }),
    NOW,
    { frozen: disjoint },
  );
  assert.equal(other.new_signups['1d'], 12);
});

test('HIGH (#822): related count metrics cannot be differenced in one release', () => {
  // 11 active users and 7 active bidders reveal four non-bidders.
  const doc = buildMetrics(row({ active_users_7d: 11, active_bidders_7d: 7 }), NOW);
  assert.equal(doc.active_users['7d'], '<5');
  assert.equal(doc.active_bidders['7d'], 7);

  // A difference of five or more is large enough to publish.
  const safe = buildMetrics(row({ active_users_7d: 12, active_bidders_7d: 7 }), NOW);
  assert.equal(safe.active_users['7d'], 12);
  assert.equal(safe.active_bidders['7d'], 7);
});

test('HIGH (#822): related counts are checked across releases too', () => {
  // Earlier releases published 15 users and 9 bidders (a six-person gap).
  const frozen = frozenLedger({
    ...countHistoryFields({ active_users_7d: [15], active_bidders_7d: [9] }),
  });
  // This run: bidders fell to 7 (two away, so withheld) and users fell to 10
  // (five away from its own history, but only one from the published bidders).
  const doc = buildMetrics(row({ active_users_7d: 10, active_bidders_7d: 7 }), NOW, { frozen });
  assert.equal(doc.active_users['7d'], '<5');
  assert.equal(doc.active_bidders['7d'], '<5');
});

test('HIGH (#822): refund counts use the same release history', () => {
  const frozen = frozenLedger({ ...countHistoryFields({ refund_count_7d: [10] }) });
  const doc = buildMetrics(
    row({
      refund_count_1d: 0,
      refund_count_7d: 11,
      refund_count_30d: 11,
      refund_contributors_7d: 11,
      refund_contributors_30d: 11,
    }),
    NOW,
    { frozen },
  );
  assert.equal(doc.refund_count['7d'], '<5');
});

test('HIGH (#822): the member snapshot is release-tracked as well', () => {
  const frozen = frozenLedger({
    ...countHistoryFields({ member_pro_members_current: [10] }),
  });
  const doc = buildMetrics(row({ member_pro_members_current: 12 }), NOW, { frozen });
  assert.equal(doc.member_pro_members.current, '<5');
});

test('HIGH (#822): a missing or inconsistent count history fails closed', () => {
  // A ledger created before count history existed cannot prove what was
  // already published, so it aborts instead of guessing.
  assert.throws(
    () =>
      parseFrozenDays({
        gross_sales_days: [],
        refund_days: [],
        released: { gross_sales_days: [], refund_days: [] },
        released_counts: { gross_sales_days: 0, refund_days: 0 },
      }),
    /missing the count release history/,
  );

  // A 1-4 was never publishable, a duplicate is corrupt, and a short array is
  // a reset attempt.
  assert.throws(
    () => parseFrozenDays(frozenLedger({ ...countHistoryFields({ new_signups_1d: [3] }) })),
    /contains a small count/,
  );
  assert.throws(
    () => parseFrozenDays(frozenLedger({ ...countHistoryFields({ new_signups_1d: [10, 10] }) })),
    /contains a duplicate/,
  );
  const shortSizes = countHistoryFields({ new_signups_1d: [10] });
  shortSizes.count_history_sizes.new_signups_1d = 0;
  assert.throws(
    () => parseFrozenDays(frozenLedger(shortSizes)),
    /count release history new_signups_1d does not match its recorded size/,
  );

  // Unknown and missing cells are inconsistent ledgers.
  const unknown = countHistoryFields();
  unknown.count_history.unknown_cell = [10];
  unknown.count_history_sizes.unknown_cell = 1;
  assert.throws(() => parseFrozenDays(frozenLedger(unknown)), /unknown cell unknown_cell/);
  const missing = countHistoryFields();
  delete missing.count_history.new_signups_1d;
  assert.throws(() => parseFrozenDays(frozenLedger(missing)), /missing new_signups_1d/);
});

test('HIGH (#822): the count history round-trips through the ledger', () => {
  const first = publishableDays(
    row({ new_signups_1d: 10, new_signups_7d: 10, new_signups_30d: 10 }),
    NOW,
  );
  const parsed = parseFrozenDays(first.days);
  assert.deepEqual(parsed.count_history.new_signups_7d, [{ day: isoDay(0), value: 10 }]);
  assert.deepEqual(parsed.count_history_sizes, first.days.count_history_sizes);

  // A later run reads that history, so the same-window difference is caught.
  const second = buildMetrics(
    row({ new_signups_1d: 11, new_signups_7d: 11, new_signups_30d: 11 }),
    NOW,
    { frozen: first.days },
  );
  assert.equal(second.new_signups['7d'], '<5');

  // The persisted next history keeps only what was actually released.
  const ledger = publishableDays(
    row({ new_signups_1d: 11, new_signups_7d: 11, new_signups_30d: 11 }),
    NOW,
    { frozen: first.days },
  );
  assert.deepEqual(ledger.days.count_history.new_signups_7d, [{ day: isoDay(0), value: 10 }]);
  assert.deepEqual(nextCountHistory({ new_signups_7d: 15 }, ledger.days.count_history, NOW), {
    ...ledger.days.count_history,
    new_signups_7d: [
      { day: isoDay(0), value: 10 },
      { day: isoDay(0), value: 15 },
    ],
  });
});

test('the workflow keeps provenance on metrics-history and guards first runs', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/metrics-status.yml', import.meta.url),
    'utf8',
  );
  // The durable ledger is read from metrics-history, never from the disposable
  // published branch.
  assert.match(workflow, /git show origin\/metrics-history:status\/metrics-days\.json/);
  assert.doesNotMatch(workflow, /git show origin\/metrics-status:status\/metrics-days\.json/);
  assert.match(workflow, /decide-ledger\.mjs/);
  assert.match(workflow, /--history-exists/);
  // Starting a new history requires an explicit dispatch confirmation.
  assert.match(workflow, /confirm_first_run/);
  assert.match(workflow, /confirmed-first-run/);
});
