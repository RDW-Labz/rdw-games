// Business metrics snapshot (#725) — pure parts: the one SELECT, the
// allowlist, the small-cohort suppression and the shape check.
//
// I/O (the Supabase Management API call and writing the file) lives in
// scripts/status-metrics.mjs so every rule here can be tested with fake rows.
//
// Read-only boundary (two layers):
//   1. assertReadOnly() rejects anything that is not one SELECT/WITH, after
//      removing comments and literals so a keyword cannot hide behind them.
//      It refuses data-modifying CTEs, SELECT INTO and every write/DDL verb.
//   2. readOnlyBody() sends it to the Management API with `read_only: true`,
//      which runs the statement in a read-only transaction (the API's own
//      `read_only` flag, not a second statement we concatenate), so even a
//      mutation the lexical guard missed fails at the database.
//
// Disclosure model for money (RED TEAM #807 HIGH): the query returns one
// bucket per *complete UTC day*, and a window's total is released only when
// every contributing day inside it had at least MIN_COHORT distinct customers.
// Windows are nested unions of complete days (1d ⊂ 7d ⊂ 30d), so 30d−7d and
// 7d−1d are themselves unions of days that each had a large cohort: neither
// direct amounts nor subtractive differences can isolate one person. Same-day
// snapshots are identical because an unfinished day is never included. One
// customer making many invoices is still one contributor. A true zero stays 0.
// Gross sales include refunded invoices, so released gross and refund amounts
// are also checked together. An attacker can select ANY gross day and add up
// ANY set of refund days, so every refund amount is withheld unless
// `min(released gross day cohorts) - sum(released refund day cohorts) >= 5`.
// Using the smallest gross day (not the largest) is what stops an unrelated
// large day from authorizing a small selectable pair. The bound uses only the
// merged (frozen) ledger — never fresh window counts — so a backfill cannot
// unlock a suppressed amount. A permanent `released` history keeps every amount
// that was ever published, so a later re-suppression or an aged-out day cannot
// make the check forget it. The published per-day ledger hides the exact
// contributor count when it is below MIN_COHORT.
//
// Disclosure model for counts (RED TEAM #807 PASS at c6bebdda, filed as #822):
// a count released once is public forever, so the durable ledger also keeps a
// `count_history` of every published cell value tagged with its snapshot day.
// A later count is withheld when it is 1–4 away from any previously published
// number, when it can be differenced against a nested window from an earlier
// release, or when a related metric (`active_users` minus `active_bidders`)
// would leave a 1–4 person cohort. The history is required on an existing
// ledger and a missing, duplicated or truncated one fails closed.
//
// Movement evidence (RED TEAM at 8fb74609): a released day keeps the record
// fingerprint it had when it was published, forever. It is never re-baselined
// to a later correction, because that would forget the original disclosure and
// let a moved subset publish on a later day (the retained release minus the
// moved subset reveals the remainder). A fingerprint never hashes an amount:
// gross evidence is over invoice ids and refund evidence over invoice +
// timestamp. A consumer-readable artifact therefore cannot be used to
// brute-force a corrected/withheld amount from a known invoice id, and a
// withheld day publishes no evidence at all.

export const WINDOWS = ['1d', '7d', '30d'];

/** A window needs this many distinct customers per contributing day. */
export const MIN_COHORT = 5;

/** Person/thing counts. A nonzero value below 5 is reported as "<5". */
export const COUNT_METRICS = [
  'active_users',
  'new_signups',
  'active_bidders',
  'lots_listed',
  'lots_sold',
  'lots_unsold',
  'auctions_run',
  'refund_count',
  'member_pro_members',
];

/**
 * Money totals in integer cents. A total is released only when its smallest
 * contributing day had at least MIN_COHORT distinct customers; otherwise it
 * becomes "<5", exactly like a small count.
 */
export const MONEY_METRICS = ['gross_sales_cents', 'refunded_cents'];

/** Per-day buckets the query returns; the window arithmetic lives below. */
export const DAILY_ALIASES = ['gross_sales_days', 'refund_days'];

/**
 * Every count cell that can be published, as a flat key. The window keys are
 * `metric_window`; the member snapshot is the one window-less count.
 *
 * A count released once is public forever, so a later release must be compared
 * against it: retained 7d=10 followed by 7d=11 reveals one new signup even when
 * the 1d cell is withheld (RED TEAM #807 PASS at c6bebdda, filed as #822).
 */
export const COUNT_HISTORY_KEYS = [
  ...COUNT_METRICS.flatMap((metric) => WINDOWS.map((window) => `${metric}_${window}`)),
  'member_pro_members_current',
];

/**
 * Count metrics where one is a strict subset of the other in the same window.
 * Bids are part of activity, so `active_users` always includes
 * `active_bidders`; their difference is the non-bidder cohort, which must obey
 * the same under-5 rule (RED TEAM #807 PASS at c6bebdda, filed as #822).
 */
export const RELATED_COUNT_PAIRS = [{ subset: 'active_bidders', superset: 'active_users' }];

/**
 * Distinct-customer cohorts for the whole window, used for complementary
 * suppression: gross sales include refunded invoices, so a released gross total
 * minus a released refund total would expose the remaining customers when the
 * residual cohort is 1–4 (RED TEAM at ed981234).
 */
export const COMPLEMENT_ALIASES = WINDOWS.flatMap((window) => [
  `gross_sales_contributors_${window}`,
  `refund_contributors_${window}`,
]);

/**
 * Remove SQL comments and literals before the keyword scan. Identifiers in
 * double quotes are removed too: `"delete"` is a column name, not a statement.
 * The scan is linear so a hostile string cannot blow the budget.
 */
function stripSqlNoise(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (ch === '$') {
      // Dollar-quoted string: $tag$ … $tag$ (tag may be empty).
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        i += marker.length;
        const end = sql.indexOf(marker, i);
        i = end < 0 ? sql.length : end + marker.length;
        out += ' ';
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|call|do|copy|vacuum|analyze|reindex|cluster|refresh|begin|commit|rollback|savepoint|release|set|reset|lock|into|returning)\b/i;

/** Refuse anything that is not one SELECT/WITH statement. */
export function assertReadOnly(sql) {
  const clean = stripSqlNoise(String(sql));
  if (!/^\s*(select|with)\b/i.test(clean)) {
    throw new Error('metrics: only SELECT/WITH queries are allowed');
  }
  if (clean.includes(';')) {
    throw new Error('metrics: one statement per query (no semicolons)');
  }
  const forbidden = WRITE_KEYWORDS.exec(clean);
  if (forbidden) {
    throw new Error(`metrics: read-only query may not contain "${forbidden[1].toUpperCase()}"`);
  }
  if (/\bfor\s+(update|share)\b/i.test(clean)) {
    throw new Error('metrics: read-only query may not lock rows');
  }
  return sql;
}

/**
 * The Management API request body: the one SELECT plus `read_only: true`.
 * The API runs it inside a read-only transaction, so a write the lexical
 * guard missed is rejected by the database rather than applied. We do not
 * concatenate a BEGIN/COMMIT ourselves — the no-semicolon rule means the
 * statement cannot escape whatever transaction the API gives it.
 */
export function readOnlyBody(sql) {
  return { query: assertReadOnly(sql), read_only: true };
}

/**
 * One SELECT. Every aggregate is a count, a sum, or a distinct-customer
 * cohort; no row values, identifiers or free text leave the database.
 *
 * Event semantics (RED TEAM #807):
 *   - listings/sales/unsold/auction runs come from the status-history tables,
 *     so a lot first published today counts today and an unsold outcome stays
 *     counted after a relist.
 *   - refunds come from operator_refund_ledger (0421), the authoritative
 *     per-refund amount+timestamp ledger, not invoice_lots.winning_bid_cents,
 *     so amount-only refunds are included.
 *   - Member Pro "current" requires an unexpired period, like is_subscriber.
 *   - active users are distinct users with a sign-in, bid, watchlist add or
 *     paid invoice in the window (a cached session with an old sign-in that
 *     bid is still active).
 */
const QUERY_TEMPLATE = `
WITH bounds AS (
  SELECT (now() AT TIME ZONE 'UTC')::date AS today
),
u AS (
  SELECT
    count(*) FILTER (WHERE created_at > now() - interval '1 day')  AS new_signups_1d,
    count(*) FILTER (WHERE created_at > now() - interval '7 days') AS new_signups_7d,
    count(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_signups_30d
  FROM auth.users
),
activity AS (
  SELECT id AS user_id, last_sign_in_at AS at
  FROM auth.users
  WHERE last_sign_in_at > now() - interval '30 days'
  UNION ALL
  SELECT bidder_id, placed_at
  FROM bids
  WHERE placed_at > now() - interval '30 days'
  UNION ALL
  SELECT bidder_id, created_at
  FROM watchlist
  WHERE created_at > now() - interval '30 days'
  UNION ALL
  SELECT i.bidder_id, i.paid_at
  FROM invoices i
  WHERE i.paid_at > now() - interval '30 days'
    AND i.paid_at IS NOT NULL
    -- A background auto-charge is not user activity. Exact timestamp equality
    -- failed because the worker makes two new Date() calls in one update,
    -- and a webhook-recovered payment can carry no last_auto_charge_at at all
    -- (RED TEAM at 3e09b41d). Allow the few-millisecond skew, and use the
    -- append-only charge_attempts log (0332) as the durable marker. Any
    -- auto_charge attempt counts, not only a successful one: a timeout/error
    -- is later settled by a Square webhook, and that recovery has neither a
    -- success row nor a close paid_at (RED TEAM at ed981234).
    --
    -- A genuine counter payment still counts even when an auto-charge was
    -- attempted earlier: mark-paid writes source='offline_mark_paid'
    -- (RED TEAM at da6ca2e1 MEDIUM 1).
    AND (
      EXISTS (
        SELECT 1 FROM charge_attempts ca
        WHERE ca.invoice_id = i.id
          AND ca.source = 'offline_mark_paid'
      )
      OR (
        NOT (
          i.last_auto_charge_at IS NOT NULL
          AND abs(extract(epoch FROM (i.paid_at - i.last_auto_charge_at))) <= 60
        )
        AND NOT EXISTS (
          SELECT 1 FROM charge_attempts ca
          WHERE ca.invoice_id = i.id
            AND ca.source = 'auto_charge'
        )
      )
    )
),
au AS (
  SELECT
    count(DISTINCT user_id) FILTER (WHERE at > now() - interval '1 day')  AS active_users_1d,
    count(DISTINCT user_id) FILTER (WHERE at > now() - interval '7 days') AS active_users_7d,
    count(DISTINCT user_id) FILTER (WHERE at > now() - interval '30 days') AS active_users_30d
  FROM activity
),
bb AS (
  SELECT
    count(DISTINCT bidder_id) FILTER (WHERE placed_at > now() - interval '1 day')  AS active_bidders_1d,
    count(DISTINCT bidder_id) FILTER (WHERE placed_at > now() - interval '7 days') AS active_bidders_7d,
    count(DISTINCT bidder_id) FILTER (WHERE placed_at > now() - interval '30 days') AS active_bidders_30d
  FROM bids
),
listed AS (
  SELECT lot_id, min(changed_at) AS at
  FROM lot_status_history
  WHERE to_status IN ('scheduled', 'live')
  GROUP BY lot_id
),
l AS (
  SELECT
    count(*) FILTER (WHERE at > now() - interval '1 day')  AS lots_listed_1d,
    count(*) FILTER (WHERE at > now() - interval '7 days') AS lots_listed_7d,
    count(*) FILTER (WHERE at > now() - interval '30 days') AS lots_listed_30d
  FROM listed
),
sold AS (
  SELECT lot_id, min(changed_at) AS at
  FROM lot_status_history
  WHERE to_status = 'won'
  GROUP BY lot_id
),
unsold AS (
  SELECT lot_id, min(changed_at) AS at
  FROM lot_status_history
  WHERE to_status = 'unsold'
    -- 0475's refund→relist path parks the lot at 'unsold' as bookkeeping. That
    -- is not an auction outcome (RED TEAM at 39f362d5).
    AND from_status IS DISTINCT FROM 'refunded'
  GROUP BY lot_id
),
ls AS (
  SELECT
    (SELECT count(*) FROM sold WHERE at > now() - interval '1 day')  AS lots_sold_1d,
    (SELECT count(*) FROM sold WHERE at > now() - interval '7 days') AS lots_sold_7d,
    (SELECT count(*) FROM sold WHERE at > now() - interval '30 days') AS lots_sold_30d,
    (SELECT count(*) FROM unsold WHERE at > now() - interval '1 day')  AS lots_unsold_1d,
    (SELECT count(*) FROM unsold WHERE at > now() - interval '7 days') AS lots_unsold_7d,
    (SELECT count(*) FROM unsold WHERE at > now() - interval '30 days') AS lots_unsold_30d
),
closed AS (
  SELECT auction_id, min(changed_at) AS at
  FROM auction_status_history
  WHERE to_status = 'closed'
  GROUP BY auction_id
),
ar AS (
  SELECT
    count(*) FILTER (WHERE at > now() - interval '1 day')  AS auctions_run_1d,
    count(*) FILTER (WHERE at > now() - interval '7 days') AS auctions_run_7d,
    count(*) FILTER (WHERE at > now() - interval '30 days') AS auctions_run_30d
  FROM closed
),
sales AS (
  SELECT
    id,
    bidder_id,
    (paid_at AT TIME ZONE 'UTC')::date AS d,
    total_cents
  FROM invoices, bounds
  WHERE status::text IN ('paid', 'partially_refunded', 'refunded')
    AND paid_at IS NOT NULL
    -- Complete UTC days only: an unfinished day can never be differenced out
    -- of two same-day snapshots (RED TEAM at 39f362d5).
    --
    -- A day that was ever released is included even after it ages out of the
    -- 30-day window, so its linked-record fingerprint can still be compared.
    -- Without that, records could move out of an aged-out published day into a
    -- new day and a subset could publish (RED TEAM at 77941b64 HIGH 3).
    AND (
      (paid_at AT TIME ZONE 'UTC')::date >= bounds.today - 30
      OR (paid_at AT TIME ZONE 'UTC')::date = ANY(__RELEASED_DAYS__)
    )
    AND (paid_at AT TIME ZONE 'UTC')::date < bounds.today
),
gs_daily AS (
  SELECT
    d,
    count(DISTINCT bidder_id) AS contributors,
    sum(total_cents)::bigint AS amount,
    -- Order-independent number-only fingerprint of the linked invoice ids. A
    -- payment-date repair changes the set of records behind a day even when the
    -- day's aggregate is unchanged, so movement cannot hide behind a masked
    -- decrease (RED TEAM at cee12a06 HIGH 1).
    (abs(coalesce(sum(hashtext(id::text)::bigint), 0)) % 1000000007)::bigint AS fingerprint
  FROM sales
  GROUP BY d
),
gs AS (
  SELECT coalesce(
    json_agg(
      json_build_object(
        'day', to_char(d, 'YYYY-MM-DD'),
        'contributors', contributors,
        'amount', amount,
        'fingerprint', fingerprint
      )
      ORDER BY d
    ),
    '[]'::json
  ) AS gross_sales_days
  FROM gs_daily
),
gsw AS (
  SELECT
    count(DISTINCT bidder_id) FILTER (WHERE d >= bounds.today - 1)  AS gross_sales_contributors_1d,
    count(DISTINCT bidder_id) FILTER (WHERE d >= bounds.today - 7)  AS gross_sales_contributors_7d,
    count(DISTINCT bidder_id) FILTER (WHERE d >= bounds.today - 30) AS gross_sales_contributors_30d
  FROM sales, bounds
),
refunds AS (
  SELECT
    r.invoice_id,
    i.bidder_id,
    r.refunded_at,
    (r.refunded_at AT TIME ZONE 'UTC')::date AS d,
    r.face_cents
  FROM operators o
  CROSS JOIN LATERAL operator_refund_ledger(o.id) r
  JOIN invoices i ON i.id = r.invoice_id
  CROSS JOIN bounds
  WHERE (
      (r.refunded_at AT TIME ZONE 'UTC')::date >= bounds.today - 30
      OR (r.refunded_at AT TIME ZONE 'UTC')::date = ANY(__RELEASED_DAYS__)
    )
    AND (r.refunded_at AT TIME ZONE 'UTC')::date < bounds.today
),
rf_daily AS (
  SELECT
    d,
    count(DISTINCT bidder_id) AS contributors,
    sum(face_cents)::bigint AS amount,
    -- Same movement detector for refunds: a re-dated override changes which
    -- refund records back a day, even when the day's total is unchanged
    -- (RED TEAM at cee12a06 HIGH 1, #812). The hash covers the row identity
    -- (invoice + refund timestamp) and NOT face_cents: hashing the amount let
    -- a consumer with a known invoice id brute-force a corrected/withheld
    -- amount from the published evidence (RED TEAM at 8fb74609 HIGH 2).
    (abs(coalesce(sum(hashtext(
      invoice_id::text || ':' ||
      to_char(refunded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
    )::bigint), 0))
      % 1000000007)::bigint AS fingerprint
  FROM refunds
  GROUP BY d
),
rfw AS (
  SELECT
    count(DISTINCT bidder_id) FILTER (WHERE d >= bounds.today - 1)  AS refund_contributors_1d,
    count(DISTINCT bidder_id) FILTER (WHERE d >= bounds.today - 7)  AS refund_contributors_7d,
    count(DISTINCT bidder_id) FILTER (WHERE d >= bounds.today - 30) AS refund_contributors_30d
  FROM refunds, bounds
),
rf AS (
  SELECT
    count(DISTINCT invoice_id) FILTER (WHERE d = bounds.today - 1) AS refund_count_1d,
    count(DISTINCT invoice_id) FILTER (WHERE d >= bounds.today - 7 AND d < bounds.today) AS refund_count_7d,
    count(DISTINCT invoice_id) FILTER (WHERE d >= bounds.today - 30 AND d < bounds.today) AS refund_count_30d,
    coalesce(
      (
        SELECT json_agg(
          json_build_object(
            'day', to_char(d, 'YYYY-MM-DD'),
            'contributors', contributors,
            'amount', amount,
            'fingerprint', fingerprint
          )
          ORDER BY d
        )
        FROM rf_daily
      ),
      '[]'::json
    ) AS refund_days
  FROM refunds, bounds
),
m AS (
  SELECT
    count(*) FILTER (
      WHERE status IN ('active', 'trialing')
        AND (current_period_end IS NULL OR current_period_end > now())
    ) AS member_pro_members_current,
    -- Activation history, not current state: a membership that started and
    -- later cancelled still counts in its activation window, and an older row
    -- that becomes active again (or renews) counts on updated_at. The window
    -- value is therefore "activated or renewed in the window" (RED TEAM at
    -- 39f362d5).
    count(*) FILTER (
      WHERE (created_at > now() - interval '1 day' AND status <> 'none')
         OR (created_at <= now() - interval '1 day'
             AND status IN ('active', 'trialing') AND updated_at > now() - interval '1 day')
    ) AS member_pro_members_1d,
    count(*) FILTER (
      WHERE (created_at > now() - interval '7 days' AND status <> 'none')
         OR (created_at <= now() - interval '7 days'
             AND status IN ('active', 'trialing') AND updated_at > now() - interval '7 days')
    ) AS member_pro_members_7d,
    count(*) FILTER (
      WHERE (created_at > now() - interval '30 days' AND status <> 'none')
         OR (created_at <= now() - interval '30 days'
             AND status IN ('active', 'trialing') AND updated_at > now() - interval '30 days')
    ) AS member_pro_members_30d
  FROM bidder_subscriptions
)
SELECT u.*, au.*, bb.*, l.*, ls.*, ar.*, gs.*, gsw.*, rf.*, rfw.*, m.*
FROM u, au, bb, l, ls, ar, gs, gsw, rf, rfw, m`;

/**
 * Render the one SELECT with the ever-released days inlined. Only validated
 * `YYYY-MM-DD` dates are embedded (they are already public), and assertReadOnly
 * still enforces a single SELECT. Including those dates is what lets an
 * aged-out released day keep its movement evidence (RED TEAM at 77941b64
 * HIGH 3).
 */
export function buildQuery(releasedDays = []) {
  const rendered = [];
  for (const raw of releasedDays) {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error('metrics: released day must be YYYY-MM-DD');
    }
    const [year, month, day] = raw.split('-').map(Number);
    const back = new Date(Date.UTC(year, month - 1, day));
    if (
      back.getUTCFullYear() !== year ||
      back.getUTCMonth() !== month - 1 ||
      back.getUTCDate() !== day
    ) {
      throw new Error('metrics: released day is not a real date');
    }
    rendered.push(`'${raw}'`);
  }
  const list = rendered.length ? `ARRAY[${rendered.join(',')}]::date[]` : 'ARRAY[]::date[]';
  return assertReadOnly(QUERY_TEMPLATE.replaceAll('__RELEASED_DAYS__', list));
}

export const QUERY = buildQuery([]);

/** Every numeric alias the published document needs, in one place. */
export function requiredAliases() {
  const aliases = [];
  for (const metric of COUNT_METRICS) {
    for (const window of WINDOWS) aliases.push(`${metric}_${window}`);
  }
  aliases.push('member_pro_members_current');
  aliases.push(...COMPLEMENT_ALIASES);
  return aliases;
}

const DECIMAL = /^(?:0|[1-9]\d*)$/;

/**
 * Accept a non-negative safe integer, or its decimal string form (Postgres
 * bigint arrives as a string through some clients). Anything else — null,
 * undefined, a negative, a fraction, "1e3", " 1", an unsafe integer — is a
 * bug and must fail the run instead of being coerced to zero.
 */
function parseCount(value, name) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`metrics: ${name} must be a non-negative safe integer`);
    }
    return value;
  }
  if (typeof value === 'string' && DECIMAL.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`metrics: ${name} is outside the safe integer range`);
    }
    return n;
  }
  throw new Error(`metrics: ${name} must be a non-negative integer`);
}

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcDayNumber(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('metrics: invalid snapshot time');
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS,
  );
}

function parseDayNumber(day, name) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) {
    throw new Error(`metrics: ${name}.day must be YYYY-MM-DD`);
  }
  const [year, month, date] = day.split('-').map(Number);
  const number = Date.UTC(year, month - 1, date) / DAY_MS;
  const back = new Date(number * DAY_MS);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== date
  ) {
    throw new Error(`metrics: ${name}.day is not a real date`);
  }
  return number;
}

function parseDailyBuckets(value, name) {
  if (!Array.isArray(value)) throw new Error(`metrics: ${name} must be an array`);
  return value.map((bucket) => {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      throw new Error(`metrics: ${name} bucket must be an object`);
    }
    return {
      day: parseDayNumber(bucket.day, name),
      contributors: parseCount(bucket.contributors, `${name}.contributors`),
      amount: parseCount(bucket.amount, `${name}.amount`),
      // Optional in fixtures; the production query always supplies it.
      fingerprint:
        bucket.fingerprint == null
          ? undefined
          : parseCount(bucket.fingerprint, `${name}.fingerprint`),
    };
  });
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('metrics: query row must be an object');
  }
  const normalized = {};
  for (const alias of requiredAliases()) {
    if (!(alias in row)) {
      throw new Error(`metrics: query row is missing ${alias}`);
    }
    normalized[alias] = parseCount(row[alias], alias);
  }
  for (const alias of DAILY_ALIASES) {
    if (!(alias in row)) {
      throw new Error(`metrics: query row is missing ${alias}`);
    }
    normalized[alias] = parseDailyBuckets(row[alias], alias);
  }
  return normalized;
}

/**
 * A nonzero count below 5 becomes the literal "<5" so a single person can
 * never be identified. A true zero stays 0: it identifies nobody, and turning
 * it into "<5" would make an empty day look like one with traffic.
 */
export function bucketUnder5(value) {
  const n = parseCount(value, 'count');
  return n > 0 && n < MIN_COHORT ? '<5' : n;
}

/**
 * Nested windows are 1d ⊂ 7d ⊂ 30d, but they used to be suppressed one cell
 * at a time. A 7-day count of 10 beside a 30-day count of 11 therefore
 * revealed a one-person remainder (RED TEAM at d1cc6545 MEDIUM 1). A
 * difference between two released windows is itself a cohort, so every pair
 * must satisfy the same under-5 rule; when it does not, the larger window is
 * withheld. This is applied after the per-cell `<5` rule and repeats until no
 * pair can be differenced into a 1–4 person cohort.
 */
export function suppressNestedCounts(values) {
  const out = {};
  for (const window of WINDOWS) {
    if (window in values) out[window] = values[window];
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < WINDOWS.length; i += 1) {
      for (let j = i + 1; j < WINDOWS.length; j += 1) {
        const smaller = out[WINDOWS[i]];
        const larger = out[WINDOWS[j]];
        if (typeof smaller !== 'number' || typeof larger !== 'number') continue;
        const remainder = larger - smaller;
        if (remainder > 0 && remainder < MIN_COHORT) {
          out[WINDOWS[j]] = '<5';
          changed = true;
        }
      }
    }
  }
  return out;
}

/**
 * Compute the count cells the fresh query would publish before any
 * cross-release check: the per-cell under-5 rule, the refund cohort rule, and
 * the nested-window rule. Returns a flat map keyed by COUNT_HISTORY_KEYS.
 */
function buildCountValues(data) {
  const flat = {};
  for (const metric of COUNT_METRICS) {
    const counts = {};
    for (const window of WINDOWS) {
      const value = data[`${metric}_${window}`];
      // A refund count from one customer is as identifying as the amount.
      // The cohort must come from the SAME fresh records as the count
      // (RED TEAM at 77941b64 MEDIUM 1).
      const cohort = metric === 'refund_count' ? data[`refund_contributors_${window}`] : null;
      counts[window] =
        cohort !== null && value > 0 && cohort < MIN_COHORT ? '<5' : bucketUnder5(value);
    }
    // Individually safe cells are not enough: nested windows can be differenced
    // into a 1–4 person remainder (RED TEAM at d1cc6545 MEDIUM 1).
    const nested = suppressNestedCounts(counts);
    for (const window of WINDOWS) flat[`${metric}_${window}`] = nested[window];
  }
  flat.member_pro_members_current = bucketUnder5(data.member_pro_members_current);
  return flat;
}

function emptyCountHistory() {
  const out = {};
  for (const key of COUNT_HISTORY_KEYS) out[key] = [];
  return out;
}

function countHistorySizes(history) {
  const out = {};
  for (const key of COUNT_HISTORY_KEYS) out[key] = history[key].length;
  return out;
}

/** Snapshot day in UTC as YYYY-MM-DD. */
function snapshotDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The complete UTC days a window covers for a snapshot taken on `day`. */
function windowInterval(day, window) {
  const days = Number(window.slice(0, -1));
  return { start: day - days, end: day - 1 };
}

function intervalsNested(a, b) {
  return (a.start >= b.start && a.end <= b.end) || (b.start >= a.start && b.end <= a.end);
}

/**
 * Apply the release history (RED TEAM #807 PASS at c6bebdda, filed as #822).
 *
 * A published count stays public forever. A later number is withheld when it
 * is not a published number and lies 1–4 away from ANY previously published
 * number, because that difference is a cohort small enough to identify people.
 * A zero difference (the same number again) reveals nobody and stays
 * publishable.
 *
 * Windows are also checked across releases. Yesterday's 1d count is a subset
 * of today's 7d count, so a two-person difference between them is a real
 * two-person cohort even though the cells are different windows. Only nested
 * intervals are compared: two overlapping windows that are not nested cannot
 * be differenced into a cohort.
 *
 * Related count metrics are checked against both the current document and the
 * history. `active_bidders` is a subset of `active_users`, so a 1–4 difference
 * is the count of non-bidder users even when the two numbers came from
 * different releases; in that case the newly released side is withheld.
 */
export function applyCountHistory(values, history = null, now = new Date()) {
  const out = { ...values };
  const entriesFor = (key) => history?.[key] ?? [];
  const remembered = (key) => entriesFor(key).map((entry) => entry.value);
  const tooClose = (a, b) => {
    const diff = Math.abs(a - b);
    return diff > 0 && diff < MIN_COHORT;
  };
  const today = utcDayNumber(now);

  // (1) Same cell across releases.
  for (const key of COUNT_HISTORY_KEYS) {
    const value = out[key];
    if (typeof value !== 'number') continue;
    if (remembered(key).some((previous) => tooClose(value, previous))) out[key] = '<5';
  }

  // (2) Same metric, nested windows across releases.
  for (const metric of COUNT_METRICS) {
    for (const window of WINDOWS) {
      const key = `${metric}_${window}`;
      const value = out[key];
      if (typeof value !== 'number') continue;
      const mine = windowInterval(today, window);
      let unsafe = false;
      for (const otherWindow of WINDOWS) {
        const otherKey = `${metric}_${otherWindow}`;
        for (const entry of entriesFor(otherKey)) {
          if (!tooClose(value, entry.value)) continue;
          const theirDay = parseDayNumber(entry.day, `${otherKey} history`);
          if (intervalsNested(mine, windowInterval(theirDay, otherWindow))) {
            unsafe = true;
            break;
          }
        }
        if (unsafe) break;
      }
      if (unsafe) out[key] = '<5';
    }
  }

  // (3) Related cells, current and historical. The difference between a subset
  // and its superset is itself a cohort, so the same under-5 rule applies.
  for (const { subset, superset } of RELATED_COUNT_PAIRS) {
    for (const window of WINDOWS) {
      const subKey = `${subset}_${window}`;
      const supKey = `${superset}_${window}`;

      // Withhold the superset when a current or already-published subset is
      // close enough to difference into 1–4 people.
      if (typeof out[supKey] === 'number') {
        const subsets = [out[subKey], ...remembered(subKey)];
        if (
          subsets.some(
            (sub) =>
              typeof sub === 'number' && out[supKey] - sub > 0 && out[supKey] - sub < MIN_COHORT,
          )
        ) {
          out[supKey] = '<5';
        }
      }

      // A superset withheld above or by its own history can still be public
      // from an earlier release, so check the subset against history too.
      if (typeof out[subKey] === 'number') {
        const supersets = [out[supKey], ...remembered(supKey)];
        if (
          supersets.some(
            (sup) =>
              typeof sup === 'number' && sup - out[subKey] > 0 && sup - out[subKey] < MIN_COHORT,
          )
        ) {
          out[subKey] = '<5';
        }
      }
    }
  }

  return out;
}

/**
 * The history to persist: every previously released entry plus every value
 * released this run, tagged with the snapshot day so later runs can prove the
 * windows are nested. Withheld cells add nothing. A repeated same-day value is
 * not duplicated; a re-run that publishes a different value keeps both.
 */
export function nextCountHistory(values, history = null, now = new Date()) {
  const day = snapshotDay(now);
  const out = {};
  for (const key of COUNT_HISTORY_KEYS) {
    const list = (history?.[key] ?? []).map((entry) => ({ ...entry }));
    const value = values[key];
    if (
      typeof value === 'number' &&
      !list.some((entry) => entry.day === day && entry.value === value)
    ) {
      list.push({ day, value });
    }
    list.sort(
      (a, b) =>
        parseDayNumber(a.day, `${key} history`) - parseDayNumber(b.day, `${key} history`) ||
        a.value - b.value,
    );
    out[key] = list;
  }
  return out;
}

function parseCountHistory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metrics: frozen ledger is missing the count release history');
  }
  for (const key of Object.keys(value)) {
    if (!COUNT_HISTORY_KEYS.includes(key)) {
      throw new Error(`metrics: count release history has an unknown cell ${key}`);
    }
  }
  const out = {};
  for (const key of COUNT_HISTORY_KEYS) {
    const list = value[key];
    if (!Array.isArray(list)) {
      throw new Error(`metrics: count release history is missing ${key}`);
    }
    const seen = new Set();
    const entries = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`metrics: count release history ${key} entry must be an object`);
      }
      const day = parseDayNumber(raw.day, `count release history ${key}`);
      const n = parseCount(raw.value, `count release history ${key}`);
      // A 1–4 was never publishable, so its presence means a corrupt or
      // forged ledger; fail closed rather than trust it.
      if (n > 0 && n < MIN_COHORT) {
        throw new Error(`metrics: count release history ${key} contains a small count`);
      }
      const id = `${raw.day}|${n}`;
      if (seen.has(id)) {
        throw new Error(`metrics: count release history ${key} contains a duplicate`);
      }
      seen.add(id);
      entries.push({ day: raw.day, value: n, dayNumber: day });
    }
    entries.sort((a, b) => a.dayNumber - b.dayNumber || a.value - b.value);
    out[key] = entries.map(({ day, value: n }) => ({ day, value: n }));
  }
  return out;
}

function parseCountHistorySizes(value, history) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metrics: frozen ledger is missing the count history sizes');
  }
  for (const key of Object.keys(value)) {
    if (!COUNT_HISTORY_KEYS.includes(key)) {
      throw new Error(`metrics: count history sizes has an unknown cell ${key}`);
    }
  }
  const out = {};
  for (const key of COUNT_HISTORY_KEYS) {
    const expected = parseCount(value[key], `count history sizes ${key}`);
    if (history[key].length !== expected) {
      throw new Error(`metrics: count release history ${key} does not match its recorded size`);
    }
    out[key] = expected;
  }
  return out;
}

/**
 * Release a money total only when every contributing day had a large enough
 * cohort. Zero is safe; a nonzero total with a small cohort becomes "<5".
 */
function moneyTotal(value, cohort) {
  if (value === 0) return 0;
  if (value === null) return '<5';
  return cohort >= MIN_COHORT ? value : '<5';
}

/**
 * Nested complete-day windows. 1d ⊂ 7d ⊂ 30d, and a window is released only
 * when each contributing day in it has MIN_COHORT customers, so any difference
 * of two released windows is also a union of large-cohort days.
 */
export function windowStats(buckets, now) {
  const today = utcDayNumber(now);
  const stats = {};
  for (const window of WINDOWS) {
    const days = Number(window.slice(0, -1));
    const inWindow = buckets.filter((bucket) => bucket.day >= today - days && bucket.day < today);
    // A day whose amount was withheld stays unknown forever: a window that
    // contains it cannot be released, even if its other days are large.
    const known = inWindow.every((bucket) => typeof bucket.amount === 'number');
    stats[window] = {
      amount: known ? inWindow.reduce((sum, bucket) => sum + bucket.amount, 0) : null,
      cohort: inWindow.length ? Math.min(...inWindow.map((bucket) => bucket.contributors)) : 0,
    };
  }
  return stats;
}

/**
 * Decide which previous ledger a run may start from (RED TEAM at d1cc6545
 * HIGH). The durable release ledger lives on its own append-only ref
 * (`metrics-history`), never on the consumer-facing `metrics-status` branch, so
 * withdrawing the published branch cannot erase disclosure history.
 *
 *   - history exists                     -> read it (`frozen`)
 *   - published exists without history   -> inconsistent, abort
 *   - neither exists                     -> abort unless a human explicitly
 *                                          confirmed that nothing was ever
 *                                          published (`first-run`)
 *
 * The confirmation is required because branch absence does not prove nothing
 * was disclosed: a consumer may still retain an older public artifact.
 */
export function decideLedgerSource({
  publishedExists = false,
  historyExists = false,
  confirmedFirstRun = false,
} = {}) {
  if (historyExists) return 'frozen';
  if (publishedExists) {
    throw new Error(
      'metrics: the published branch exists but its durable disclosure history is missing; refusing to re-initialize',
    );
  }
  if (!confirmedFirstRun) {
    throw new Error(
      'metrics: no durable disclosure history; refusing to initialize without an explicit first-run confirmation',
    );
  }
  return 'first-run';
}

/**
 * Parse the previously published per-day ledger. Every entry is validated; a
 * malformed ledger fails closed instead of silently recomputing history.
 * `amount: null` means the day had a small cohort and its amount was withheld.
 */
export function parseFrozenDays(value) {
  // `null` means there was no previous ledger. Only a verified first run may
  // pass it; a missing file after a failed read is handled by the caller and
  // must abort instead of silently recomputing history (RED TEAM at ed981234).
  if (value == null) {
    return {
      gross_sales_days: [],
      refund_days: [],
      released: { gross_sales_days: [], refund_days: [] },
      count_history: emptyCountHistory(),
      count_history_sizes: countHistorySizes(emptyCountHistory()),
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metrics: frozen days must be an object');
  }
  const out = {};
  for (const alias of DAILY_ALIASES) {
    if (!(alias in value) || value[alias] == null) {
      throw new Error(`metrics: frozen ledger is missing ${alias}`);
    }
    const days = value[alias];
    if (!Array.isArray(days)) throw new Error(`metrics: frozen ${alias} must be an array`);
    out[alias] = days.map((bucket) => {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
        throw new Error(`metrics: frozen ${alias} bucket must be an object`);
      }
      const amount = bucket.amount === null ? null : parseCount(bucket.amount, `${alias}.amount`);
      // A published count of 1–4 is itself identifying (RED TEAM at ed981234):
      // a suppressed bucket stores `contributors: null`.
      const contributors =
        bucket.contributors == null ? 0 : parseCount(bucket.contributors, `${alias}.contributors`);
      const day = parseDayNumber(bucket.day, alias);
      if (contributors === 0 && amount !== null) {
        throw new Error(`metrics: frozen ${alias} bucket has an amount without contributors`);
      }
      // The record fingerprint proves that the linked records behind a
      // published day did not move. A published day without one cannot be
      // checked, so it must abort rather than silently trust the aggregate
      // (RED TEAM at cee12a06 HIGH 1).
      if (amount !== null && bucket.fingerprint == null) {
        throw new Error(`metrics: frozen ${alias} bucket has an amount without a fingerprint`);
      }
      const fingerprint =
        bucket.fingerprint == null ? 0 : parseCount(bucket.fingerprint, `${alias}.fingerprint`);
      return { day, contributors, amount, fingerprint };
    });
  }
  out.released = parseReleased(value.released);
  // The permanent release history must be consistent with the days this ledger
  // still calls published: every published amount has to be in it. Emptying the
  // arrays while leaving a published day behind is a reset attempt
  // (RED TEAM at cee12a06 HIGH 2).
  for (const alias of DAILY_ALIASES) {
    const releasedByDay = new Map(out.released[alias].map((bucket) => [bucket.day, bucket]));
    for (const bucket of out[alias]) {
      if (bucket.amount === null) continue;
      const remembered = releasedByDay.get(bucket.day);
      if (
        !remembered ||
        remembered.amount !== bucket.amount ||
        remembered.contributors !== bucket.contributors
      ) {
        throw new Error(`metrics: released ${alias} is missing a published day`);
      }
    }
  }
  // Per-alias counts make a deleted or truncated history detectable even after
  // every released day has aged out of the 30-day ledger. The history only
  // grows; a shorter array than the persisted count is a reset attempt
  // (RED TEAM at cee12a06 HIGH 2).
  const counts = value.released_counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('metrics: frozen ledger is missing released_counts');
  }
  for (const alias of DAILY_ALIASES) {
    const expected = parseCount(counts[alias], `released_counts.${alias}`);
    if (out.released[alias].length < expected) {
      throw new Error(`metrics: released ${alias} history shrank`);
    }
  }
  // Count releases are disclosure history too. They are REQUIRED for the same
  // reason as the money history: without them a later count could be
  // differenced against a number a consumer already retained (RED TEAM #807
  // PASS at c6bebdda, filed as #822). Only a verified first run initializes
  // them empty.
  out.count_history = parseCountHistory(value.count_history);
  out.count_history_sizes = parseCountHistorySizes(value.count_history_sizes, out.count_history);
  return out;
}

/**
 * Every amount ever released, kept forever so a later re-suppression cannot
 * make the disclosure check forget it (RED TEAM at 08fa83f0 HIGH 2).
 *
 * RED TEAM at 4f6eb4c7 HIGH 3 / cee12a06 HIGH 2: a missing or partial history
 * must not be silently rebuilt from the current buckets. Deleting the
 * `released` field would otherwise forget aged-out or re-suppressed
 * disclosures and let the same amount publish again. The history is therefore
 * REQUIRED on every existing ledger; only a verified first run
 * (`parseFrozenDays(null)`) may initialize it empty. A corrupt history fails
 * closed.
 */
function parseReleased(value) {
  const out = {};
  // Only `parseFrozenDays(null)` — a workflow-verified first run — may assume
  // no prior disclosure. Any existing ledger must carry its permanent history:
  // after releases age out of the 30-day ledger the history is the only record
  // that they were ever published (RED TEAM at cee12a06 HIGH 2).
  if (value == null) {
    throw new Error('metrics: frozen ledger is missing the released history');
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metrics: released history must be an object');
  }
  for (const alias of DAILY_ALIASES) {
    const buckets = value[alias];
    if (!Array.isArray(buckets)) {
      throw new Error(`metrics: released ${alias} must be an array`);
    }
    out[alias] = buckets.map((bucket) => {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
        throw new Error(`metrics: released ${alias} bucket must be an object`);
      }
      const amount = parseCount(bucket.amount, `released ${alias}.amount`);
      const contributors = parseCount(bucket.contributors, `released ${alias}.contributors`);
      if (contributors < MIN_COHORT) {
        throw new Error(`metrics: released ${alias} bucket has a small cohort`);
      }
      // Movement evidence is REQUIRED for a released amount. Without it the
      // day cannot be re-checked, so a ledger that lost the fingerprint must
      // fail closed instead of silently adopting a new baseline (RED TEAM at
      // 8fb74609 HIGH 1). There is no pre-evidence ledger in production: the
      // snapshot branch is created by this feature.
      const fingerprint = parseCount(bucket.fingerprint, `released ${alias}.fingerprint`);
      return {
        day: parseDayNumber(bucket.day, `released ${alias}`),
        contributors,
        amount,
        fingerprint,
      };
    });
  }
  return out;
}

function mergeReleasedHistory(released, gross, refund) {
  const build = (previous, current) => {
    const byDay = new Map((previous ?? []).map((bucket) => [bucket.day, { ...bucket }]));
    // Movement evidence is immutable once a day has been released. Refreshing
    // it to the fresh record set after a correction let a moved subset publish
    // on a later day: the retained release minus that subset reveals the
    // remainder, and a second move after the refresh went undetected (RED TEAM
    // at 8fb74609 HIGH 1). A day that no longer matches its published evidence
    // therefore keeps failing closed until the records are restored.
    for (const bucket of current) {
      if (byDay.has(bucket.day)) continue;
      if (bucket.amount !== null && bucket.contributors >= MIN_COHORT) {
        if (typeof bucket.fingerprint !== 'number') {
          // A new release without record evidence could never be re-checked.
          throw new Error('metrics: released day is missing a movement fingerprint');
        }
        byDay.set(bucket.day, { ...bucket });
      }
    }
    return [...byDay.values()].sort((a, b) => a.day - b.day);
  };
  return {
    gross_sales_days: build(released?.gross_sales_days, gross),
    refund_days: build(released?.refund_days, refund),
  };
}

/**
 * Immutable release (RED TEAM #807 HIGH): a day bucket that has ever been
 * published wins over a freshly computed one. Later ledger corrections — a
 * manager override re-dated onto an older refund day, a backfill — can never
 * move a published day, so subtracting retained snapshots cannot isolate the
 * correction.
 *
 * Movement model (RED TEAM at cee12a06 / 77941b64):
 *   - Every day bucket carries a number-only fingerprint of its linked records.
 *   - The ever-released history keeps the evidence for previously published
 *     contributions, so movement is still detected after a day is re-suppressed
 *     or ages out of the 30-day window (the query includes released days).
 *   - ANY change to a published day's linked records is movement. There is no
 *     "it only grew" shortcut: an outgoing move can be masked by an incoming
 *     replacement that keeps the total and cohort the same or larger.
 *   - Detection fails closed for the whole series: keep the already-published
 *     frozen days, but withhold every NEW day in this run, because we cannot
 *     tell which new day absorbed the moved records. A day at or before the
 *     newest published day is a backfill/repair, not the normal next day.
 */
export function mergeFrozenDays(current, frozen, { today = null, releasedDays = [] } = {}) {
  const inScope = (day) => today == null || (day >= today - 30 && day < today);
  const currentByDay = new Map(current.map((bucket) => [bucket.day, bucket]));
  const frozenByDay = new Map(frozen.map((bucket) => [bucket.day, bucket]));
  const releasedByDay = new Map((releasedDays ?? []).map((bucket) => [bucket.day, bucket]));
  // Days we already know about: a new day means a genuinely new calendar day,
  // not a day that was released earlier and is now being reintroduced.
  const known = new Set([...frozenByDay.keys(), ...releasedByDay.keys()]);
  let moved = false;

  // (1) Ever-released days are authoritative. Compare the fresh linked-record
  // fingerprint with the release history, whether the source is still in the
  // 30-day ledger, was re-suppressed, or has aged out (RED TEAM at 77941b64
  // HIGH 3). The query returns released days specifically for this check.
  for (const [day, rel] of releasedByDay) {
    const cur = currentByDay.get(day);
    if (!cur) {
      // The released records vanished from their published date.
      if (typeof rel.fingerprint === 'number') moved = true;
      continue;
    }
    if (typeof rel.fingerprint === 'number' && typeof cur.fingerprint === 'number') {
      // A different record set is movement. An identical fingerprint with a
      // different aggregate is also a change to the released day (an in-place
      // amount correction); fail closed rather than trust it.
      if (
        rel.fingerprint !== cur.fingerprint ||
        cur.amount !== rel.amount ||
        cur.contributors !== rel.contributors
      ) {
        moved = true;
      }
    } else if (rel.fingerprint == null) {
      // Legacy history without movement evidence: adopt the fresh records only
      // when the published aggregate is unchanged; otherwise fail closed.
      if (cur.amount !== rel.amount || cur.contributors !== rel.contributors) moved = true;
    } else {
      // We have evidence but the fresh row lost its fingerprint.
      moved = true;
    }
  }

  // (2) Frozen published days not in the release history (defensive: the
  // ledger invariant says this should not happen).
  for (const [day, frozenBucket] of frozenByDay) {
    if (releasedByDay.has(day)) continue;
    if (!inScope(day)) continue;
    if (typeof frozenBucket.amount !== 'number') continue;
    const currentBucket = currentByDay.get(day);
    if (!currentBucket) {
      moved = true;
      continue;
    }
    const frozenFingerprint = frozenBucket.fingerprint;
    const currentFingerprint = currentBucket.fingerprint;
    if (
      typeof frozenFingerprint === 'number' &&
      typeof currentFingerprint === 'number' &&
      frozenFingerprint !== currentFingerprint
    ) {
      moved = true;
    } else if (
      currentBucket.amount !== frozenBucket.amount ||
      currentBucket.contributors !== frozenBucket.contributors
    ) {
      moved = true;
    }
  }

  // (3) A brand-new day at or before the newest published day is a
  // backfill/repair, not the normal next complete day. Fail closed.
  let maxPublishedDay = null;
  for (const bucket of releasedByDay.values()) {
    if (maxPublishedDay === null || bucket.day > maxPublishedDay) maxPublishedDay = bucket.day;
  }
  for (const [day, bucket] of frozenByDay) {
    if (typeof bucket.amount !== 'number') continue;
    if (maxPublishedDay === null || day > maxPublishedDay) maxPublishedDay = day;
  }
  if (maxPublishedDay !== null) {
    for (const bucket of current) {
      if (!known.has(bucket.day) && bucket.day <= maxPublishedDay) {
        moved = true;
        break;
      }
    }
  }

  const byDay = new Map();
  for (const bucket of current) {
    if (!known.has(bucket.day) && moved) {
      // Taint every genuinely new day. A persisted null amount wins on later
      // runs, so this day stays withheld forever.
      byDay.set(bucket.day, { ...bucket, amount: null, fingerprint: null });
    } else {
      byDay.set(bucket.day, bucket);
    }
  }
  for (const bucket of frozen) byDay.set(bucket.day, bucket);
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

/**
 * Gross sales include refunded invoices, so a released gross amount minus a
 * released refund amount can isolate the customers who were not refunded.
 *
 * RED TEAM at da6ca2e1: comparing only same-date buckets left the sidecar
 * exposed when the gross and the refund sat on different days. The bound must
 * cover the whole published horizon, because an attacker can add up any subset
 * of the per-day ledger:
 *
 *   residual customers >= max(gross contributors on any released day)
 *                        - sum(refund contributors on released days)
 *
 * The first term is a lower bound on the distinct gross customers (a window is
 * at least as large as its largest day). The second is an upper bound on the
 * distinct refunded customers (their union cannot exceed the sum). Withholding
 * every refund amount when that bound is below MIN_COHORT therefore makes any
 * multi-day subtraction safe. Contributors come only from the merged (frozen)
 * ledger, never from fresh window counts, so a historical backfill cannot
 * unlock a previously suppressed amount (RED TEAM at da6ca2e1 HIGH 2).
 */
export function suppressComplementary(grossBuckets, refundBuckets, released = null) {
  const byDay = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  const gross = [...grossBuckets].sort(byDay);
  const refund = [...refundBuckets].sort(byDay);

  // Selectable-subset bound. An attacker can pick ANY gross day amount and add
  // up ANY set of refund day amounts (RED TEAM at 08fa83f0 HIGH 1). The union
  // of the selected gross customers is at least the SMALLEST released gross
  // day's cohort (they can select that day alone), and the refunded customers
  // are at most the SUM of every released refund day's cohort. A larger,
  // unrelated day must not make a smaller pair releasable.
  //
  // `released` is the permanent ever-released history, so a refund that was
  // published once still counts after a later run re-suppresses it or it ages
  // out (RED TEAM at 08fa83f0 HIGH 2/3).
  const releasedGross = released?.gross_sales_days ?? [];
  const releasedRefund = released?.refund_days ?? [];
  const grossByDay = new Map();
  for (const bucket of [...releasedGross, ...gross]) {
    // A moved/withheld day still has real customers: including its cohort can
    // only lower the minimum, so the residual bound stays conservative.
    if (bucket.contributors < MIN_COHORT) continue;
    if (!grossByDay.has(bucket.day)) grossByDay.set(bucket.day, bucket);
  }
  const refundByDay = new Map();
  for (const bucket of [...releasedRefund, ...refund]) {
    // Likewise, a withheld refund day still represents refunded customers;
    // counting them keeps the sum bound conservative.
    if (bucket.contributors < MIN_COHORT) continue;
    if (!refundByDay.has(bucket.day)) refundByDay.set(bucket.day, bucket);
  }
  const grossCohorts = [...grossByDay.values()].map((bucket) => bucket.contributors);
  const minGrossCohort = grossCohorts.length ? Math.min(...grossCohorts) : 0;
  const refundCohortSum = [...refundByDay.values()].reduce(
    (sum, bucket) => sum + bucket.contributors,
    0,
  );
  const tooClose =
    refundCohortSum > 0 && (minGrossCohort === 0 || minGrossCohort - refundCohortSum < MIN_COHORT);

  // RED TEAM at 4f6eb4c7 HIGH 1: an amount already released cannot be taken
  // back. If a refund was published on an earlier run, a LATER gross day that
  // overlaps those customers lets an attacker subtract the retained refund from
  // the new gross and isolate a 1–4 person remainder. The released refund is
  // irrevocable, so the new gross must be withheld instead. Worst case every
  // released refund customer is inside this gross bucket, so bound the overlap
  // by the sum of released refund cohorts. A gross bucket may only publish when
  // `contributors - releasedRefundCohortSum >= MIN_COHORT` (or when nothing has
  // been refund-released yet).
  const releasedRefundCohortSum = releasedRefund
    .filter((bucket) => bucket.amount !== null && bucket.contributors >= MIN_COHORT)
    .reduce((sum, bucket) => sum + bucket.contributors, 0);
  const grossTooClose = (bucket) =>
    releasedRefundCohortSum > 0 &&
    bucket.contributors >= MIN_COHORT &&
    bucket.contributors - releasedRefundCohortSum < MIN_COHORT;

  return {
    gross: gross.map((bucket) => ({
      ...bucket,
      amount:
        bucket.amount !== null && bucket.contributors >= MIN_COHORT && !grossTooClose(bucket)
          ? bucket.amount
          : null,
    })),
    refund: refund.map((bucket) => ({
      ...bucket,
      amount:
        bucket.amount !== null && bucket.contributors >= MIN_COHORT && !tooClose
          ? bucket.amount
          : null,
    })),
  };
}

/**
 * The per-day ledger to persist for the next run: the merged (frozen) buckets
 * inside the 30-day horizon, with a small cohort's amount withheld. Only
 * numbers and dates are written.
 */
export function publishableDays(row, now = new Date(), { frozen = null } = {}) {
  const data = normalizeRow(row);
  const frozenDays = parseFrozenDays(frozen);
  const today = utcDayNumber(now);
  const inHorizon = (bucket) => bucket.day >= today - 30 && bucket.day < today;
  const mergedGross = mergeFrozenDays(data.gross_sales_days, frozenDays.gross_sales_days, {
    today,
    releasedDays: frozenDays.released.gross_sales_days,
  });
  const mergedRefund = mergeFrozenDays(data.refund_days, frozenDays.refund_days, {
    today,
    releasedDays: frozenDays.released.refund_days,
  });
  const merged = suppressComplementary(
    mergedGross.filter(inHorizon),
    mergedRefund.filter(inHorizon),
    frozenDays.released,
  );
  // Remember every amount released now, and keep every amount released before
  // even if this run re-suppressed it or it has aged out (RED TEAM at
  // 08fa83f0 HIGH 2/3). The fresh row is the movement evidence for days that
  // are already in the release history, including aged-out ones.
  const released = mergeReleasedHistory(frozenDays.released, merged.gross, merged.refund);
  // Count releases are public forever. Decide them exactly as buildMetrics does
  // (same row, same frozen history) so the persisted history is the set of
  // numbers the published document actually disclosed (RED TEAM #807 PASS at
  // c6bebdda, filed as #822).
  const publishedCounts = applyCountHistory(buildCountValues(data), frozenDays.count_history, now);
  const countHistory = nextCountHistory(publishedCounts, frozenDays.count_history, now);
  const fingerprintByDay = (buckets) =>
    new Map(buckets.map((bucket) => [bucket.day, bucket.fingerprint]));
  const releasedFingerprints = {
    gross_sales_days: fingerprintByDay(released.gross_sales_days),
    refund_days: fingerprintByDay(released.refund_days),
  };
  const serialize = (buckets, evidenceByDay) =>
    buckets.map((bucket) => {
      const publicAmount = bucket.amount !== null && bucket.contributors >= MIN_COHORT;
      const evidence = evidenceByDay.get(bucket.day);
      return {
        day: new Date(bucket.day * DAY_MS).toISOString().slice(0, 10),
        // A count of 1–4 is identifying even when the amount is withheld
        // (RED TEAM at ed981234): store `null` instead of the exact count.
        contributors: bucket.contributors >= MIN_COHORT ? bucket.contributors : null,
        amount: publicAmount ? bucket.amount : null,
        // A number-only record fingerprint, not a count or customer field. It
        // lets the next run prove the linked records behind a released day did
        // not move (RED TEAM at cee12a06 HIGH 1).
        //
        // Publish evidence ONLY for a day whose amount is public, and prefer
        // the immutable fingerprint recorded when it was released. A fresh
        // fingerprint for a corrected/withheld day is exactly the bounded-guess
        // channel RED TEAM closed at 8fb74609 HIGH 2: varying the hidden amount
        // must leave the artifact byte-identical. A withheld day carries none.
        fingerprint: publicAmount
          ? typeof evidence === 'number'
            ? evidence
            : typeof bucket.fingerprint === 'number'
              ? bucket.fingerprint
              : // Published before movement evidence existed (or a fixture):
                // keep a numeric "unknown" marker so the ledger invariant
                // holds. A real query always supplies a fingerprint.
                0
          : null,
      };
    });
  const serializeReleased = (buckets) =>
    buckets.map((bucket) => ({
      day: new Date(bucket.day * DAY_MS).toISOString().slice(0, 10),
      contributors: bucket.contributors,
      amount: bucket.amount,
      // The amount is public in this record, so the movement evidence is safe
      // here; it covers re-suppression and age-out (RED TEAM at 77941b64
      // HIGH 3).
      fingerprint: typeof bucket.fingerprint === 'number' ? bucket.fingerprint : null,
    }));
  return {
    generated_at: new Date(now).toISOString(),
    days: {
      gross_sales_days: serialize(merged.gross, releasedFingerprints.gross_sales_days),
      refund_days: serialize(merged.refund, releasedFingerprints.refund_days),
      released: {
        gross_sales_days: serializeReleased(released.gross_sales_days),
        refund_days: serializeReleased(released.refund_days),
      },
      // Monotonic per-alias counts: a later run can tell if release history was
      // truncated, even after every released day has aged out of the 30-day
      // ledger (RED TEAM at cee12a06 HIGH 2).
      released_counts: {
        gross_sales_days: released.gross_sales_days.length,
        refund_days: released.refund_days.length,
      },
      // Every count number ever published, per cell, plus its length so a
      // deleted or truncated array fails closed even when no newer value is
      // close enough to expose it (RED TEAM #807 PASS at c6bebdda, #822).
      count_history: countHistory,
      count_history_sizes: countHistorySizes(countHistory),
    },
  };
}

/**
 * Build the published document from one query row. Only allowlisted fields are
 * copied; anything else the query returns is ignored. Malformed rows fail
 * closed before anything is written. `frozen` is the previous run's per-day
 * ledger (see publishableDays); published days are never recomputed.
 */
export function buildMetrics(row, now = new Date(), { frozen = null } = {}) {
  const data = normalizeRow(row);
  const frozenDays = parseFrozenDays(frozen);
  const doc = { generated_at: new Date(now).toISOString() };
  // Use the same 30-day horizon and the same ever-released history as the
  // sidecar, so an aged-out large day cannot authorize a current release that
  // the sidecar suppresses (RED TEAM at 08fa83f0 HIGH 3).
  const today = utcDayNumber(now);
  const inHorizon = (bucket) => bucket.day >= today - 30 && bucket.day < today;
  const mergedGross = mergeFrozenDays(data.gross_sales_days, frozenDays.gross_sales_days, {
    today,
    releasedDays: frozenDays.released.gross_sales_days,
  });
  const mergedRefund = mergeFrozenDays(data.refund_days, frozenDays.refund_days, {
    today,
    releasedDays: frozenDays.released.refund_days,
  });
  const merged = suppressComplementary(
    mergedGross.filter(inHorizon),
    mergedRefund.filter(inHorizon),
    frozenDays.released,
  );
  const statsByMetric = {
    gross_sales_cents: windowStats(merged.gross, now),
    refunded_cents: windowStats(merged.refund, now),
  };

  // Complementary suppression is already applied to the merged day ledger
  // above. Do NOT consult the fresh `*_contributors_*` window counts for the
  // MONEY totals: they are not frozen with the amounts, so a later historical
  // backfill could raise a count and publish a refund amount that was
  // suppressed when the release was frozen (RED TEAM at da6ca2e1 HIGH 2).

  for (const metric of COUNT_METRICS) {
    doc[metric] = {};
  }
  const countValues = applyCountHistory(buildCountValues(data), frozenDays.count_history, now);
  for (const key of COUNT_HISTORY_KEYS) {
    const value = countValues[key];
    if (key === 'member_pro_members_current') {
      doc.member_pro_members.current = value;
      continue;
    }
    const metric = key.slice(0, key.lastIndexOf('_'));
    const window = key.slice(key.lastIndexOf('_') + 1);
    doc[metric][window] = value;
  }

  for (const metric of MONEY_METRICS) {
    doc[metric] = {};
    for (const window of WINDOWS) {
      const { amount, cohort } = statsByMetric[metric][window];
      doc[metric][window] = moneyTotal(amount, cohort);
    }
  }

  return doc;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Fail if any leaf is not a number, the "<5" sentinel, or the one ISO date.
 * This is the test the ticket asks for: a string (a name, an id, free text)
 * anywhere in the document makes the job fail instead of publishing it.
 */
export function assertMetricsShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('metrics: document must be an object');
  }
  if (typeof doc.generated_at !== 'string' || !ISO_DATE.test(doc.generated_at)) {
    throw new Error('metrics: generated_at must be an ISO timestamp');
  }
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'generated_at') continue;
    assertNumericGroup(key, value);
  }
  return doc;
}

function assertNumericGroup(name, group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(`metrics: ${name} must be an object of numbers`);
  }
  for (const [window, value] of Object.entries(group)) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`metrics: ${name}.${window} must be a non-negative integer`);
      }
      continue;
    }
    if (value === '<5') continue;
    throw new Error(`metrics: ${name}.${window} is not a number or "<5"`);
  }
}
