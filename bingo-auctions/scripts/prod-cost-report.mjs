#!/usr/bin/env node
// ============================================================================
// scripts/prod-cost-report.mjs
//
// Weekly read-only cost report against BinGo prod. Watches what a query COSTS,
// not how it is spelled.
//
// ── WHY THIS EXISTS, AND WHY IT IS NOT A CI GATE ────────────────────────────
// On 2026-09-19 the site was unusable for 45 minutes during the close hour.
// Cause: one lookup on `lots` that no index could serve, running once per
// public lot page view — 1,181,337 calls at 95.56 ms, 31.4 CPU-hours over 11
// days, 42 billion tuples read by sequential scan. It saturated the instance
// and every pg_cron job started failing with `connection failed`.
//
// The obvious reaction was a PR gate banning leading wildcards in queries.
// That was rejected on purpose. The wildcard was never the signal:
//
//   * The identical filter was harmless at 12,000 rows. Cost is rows x calls,
//     and neither appears in a diff. A syntactic gate cannot see either.
//   * Legitimate staff-facing `ilike` searches (operator inventory, worklist)
//     would trip it immediately, earn an ignore-comment, and teach everyone to
//     ignore the gate.
//   * The next expensive query will be spelled differently anyway — a function
//     on a column, a non-sargable cast, an OR across two tables — and a
//     wildcard rule would wave it through.
//
// So this watches the outcome instead. It cannot block a PR, which means
// nobody learns to route around it, and it catches the whole class rather than
// one spelling. The 2026-09-19 signal was visible for five days beforehand:
// the saturation episodes began 09-14.
//
// ── READ-ONLY BY CONSTRUCTION ───────────────────────────────────────────────
// Every statement is a SELECT against a pg_catalog / pg_stat view. It writes
// nothing, takes no locks, and reads no customer data — only query shapes,
// counters and table statistics. Safe at any hour, including warehouse hours
// (CLAUDE.md Rule 9), which is why it can run on a schedule at all.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/prod-cost-report.mjs
//   node scripts/prod-cost-report.mjs --json     # machine-readable, for CI
// ============================================================================

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'npwseclcxcatjhgjrtwe';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const JSON_OUT = process.argv.includes('--json');

if (!PAT) {
  console.error('[cost-report] SUPABASE_ACCESS_TOKEN is required.');
  process.exit(1);
}

// ── Thresholds ──────────────────────────────────────────────────────────────
// Set from the 2026-09-19 incident and the fortnight around it, so each one
// has a real number behind it rather than a round guess.
const T = {
  // A table read end to end. `lots` sat at ~25,955 tuples per scan against
  // 29,175 live rows — essentially 100%. Healthy tables index-scan instead.
  SCAN_RATIO: 0.5,
  // Ignore tables nobody scans much; a handful of full scans on a small
  // lookup table is normal and not worth a line of output.
  SCAN_MIN_SCANS: 1000,
  // Share of total database time held by a single statement. The lot-code
  // lookup held 68% of it. Anything over a fifth is worth a look.
  QUERY_TIME_SHARE: 0.2,
  // Connection headroom. max_connections is 60 and ~53 sit held by managed
  // pools at idle, so this is genuinely tight and worth reporting every week.
  CONN_HEADROOM: 0.2,
  // pg_cron failures in one 15-minute bucket. Quiet days peak at 0-2;
  // saturation events landed at 24-36. 10 is the middle of an empty gap.
  CRON_FAILURES_15M: 10,
};

async function q(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`query failed ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

// NOTE: no double quotes anywhere in these statements. The sibling
// `apply-migration.yml` passes SQL through a shell that breaks on them, and
// keeping the same discipline here means any of these can be pasted into that
// workflow during an incident without being rewritten first.
const SQL = {
  // Two row counts on purpose. pg_stat_user_tables.n_live_tup is maintained
  // incrementally and resets with the stats collector; pg_class.reltuples is
  // the planner's number, rewritten by ANALYZE. They can disagree enormously:
  // on 2026-09-20 import_rows read 8,695 from the first and 297,987 actual,
  // which made an earlier version of this report print a 3273% scan ratio for
  // a table that was really being scanned at 95%. Taking the larger keeps the
  // ratio honest, and a big disagreement is itself reported — stale stats mean
  // the planner is choosing plans from fiction.
  scans: `
    SELECT s.relname AS table_name, s.seq_scan, s.seq_tup_read,
           s.n_live_tup,
           c.reltuples::bigint AS reltuples,
           greatest(s.n_live_tup, c.reltuples::bigint) AS est_rows,
           CASE WHEN s.seq_scan > 0 THEN s.seq_tup_read / s.seq_scan ELSE 0 END AS tuples_per_scan,
           pg_size_pretty(pg_relation_size(s.relid)) AS heap_size
    FROM pg_stat_user_tables s
    JOIN pg_class c ON c.oid = s.relid
    WHERE s.seq_scan >= ${T.SCAN_MIN_SCANS}
      AND greatest(s.n_live_tup, c.reltuples::bigint) > 1000
    ORDER BY s.seq_tup_read DESC LIMIT 15`,

  statements: `
    WITH tot AS (SELECT sum(total_exec_time) AS t FROM pg_stat_statements)
    SELECT left(regexp_replace(query, E'\\\\s+', chr(32), chr(103)), 160) AS query,
           calls,
           round((total_exec_time/1000)::numeric, 1) AS total_s,
           round(mean_exec_time::numeric, 2) AS mean_ms,
           round((100 * total_exec_time / nullif((SELECT t FROM tot), 0))::numeric, 1) AS pct_of_db_time
    FROM pg_stat_statements
    ORDER BY total_exec_time DESC LIMIT 10`,

  connections: `
    SELECT (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
           (SELECT setting::int FROM pg_settings WHERE name = 'superuser_reserved_connections') AS reserved,
           (SELECT count(*)::int FROM pg_stat_activity) AS in_use`,

  cron: `
    WITH b AS (
      SELECT to_timestamp(floor(extract(epoch FROM start_time) / 900) * 900) AS bucket,
             count(*) FILTER (WHERE status <> 'succeeded') AS failed,
             count(*) FILTER (WHERE return_message LIKE '%connection failed%') AS conn_failed
      FROM cron.job_run_details
      WHERE start_time > now() - interval '7 days'
      GROUP BY 1
    )
    SELECT to_char(bucket, 'MM-DD HH24:MI') AS bucket, failed, conn_failed
    FROM b WHERE failed >= ${T.CRON_FAILURES_15M}
    ORDER BY bucket DESC LIMIT 20`,

  stats_reset: `SELECT stats_reset::text AS since FROM pg_stat_statements_info`,
};

const fmt = (n) => Number(n).toLocaleString('en-US');

async function main() {
  const [scans, statements, conns, cron, reset] = await Promise.all([
    q(SQL.scans), q(SQL.statements), q(SQL.connections), q(SQL.cron), q(SQL.stats_reset),
  ]);

  const findings = [];

  for (const r of scans) {
    const est = Number(r.est_rows);
    const ratio = est > 0 ? Number(r.tuples_per_scan) / est : 0;
    if (ratio >= T.SCAN_RATIO) {
      findings.push(
        `**${r.table_name}** is being read end to end: ${fmt(r.tuples_per_scan)} tuples per scan ` +
        `against ~${fmt(est)} rows (${Math.round(ratio * 100)}%), ` +
        `${fmt(r.seq_scan)} scans, ${fmt(r.seq_tup_read)} tuples total. ` +
        `Something queries it without an index it can use.`,
      );
    }

    // A disagreement between the two counts means the MONITORING number is
    // stale, not necessarily the planner's. Worth reporting because it makes
    // every other number in this report for that table untrustworthy — but
    // stated carefully, because the obvious reading is wrong twice over:
    //
    //   * The planner reads pg_class.reltuples, which ANALYZE maintains.
    //     n_live_tup is the stats collector's incremental counter and resets
    //     with pg_stat_reset(). On 2026-09-20 import_rows read 8,695 here and
    //     273,381 there, against 297,987 actual — so reltuples was 8% off and
    //     fine, while n_live_tup was 31x wrong and used by nothing that plans.
    //   * Autovacuum thresholds are computed from reltuples too, so a table in
    //     this state is usually behaving correctly, not starved.
    const live = Number(r.n_live_tup);
    const rel = Number(r.reltuples);
    const lo = Math.min(live, rel);
    const hi = Math.max(live, rel);
    if (hi > 1000 && (lo <= 0 || hi / lo >= 2)) {
      findings.push(
        `**${r.table_name}**: the two row counts disagree — pg_stat says ${fmt(live)} live rows, ` +
        `pg_class.reltuples says ${fmt(rel)}. reltuples is what the planner and the autovacuum ` +
        `thresholds use, so this is usually a reset stats collector rather than a planning ` +
        `problem. Treat this table's other rows in this report as approximate, and confirm ` +
        `against SELECT count(*) before acting on them.`,
      );
    }
  }

  for (const r of statements) {
    if (Number(r.pct_of_db_time) >= T.QUERY_TIME_SHARE * 100) {
      findings.push(
        `One statement holds **${r.pct_of_db_time}% of all database time** ` +
        `(${fmt(r.calls)} calls, ${r.mean_ms} ms mean, ${fmt(r.total_s)} s total):\n` +
        '    ' + r.query,
      );
    }
  }

  const c = conns[0] ?? {};
  const usable = Number(c.max_connections) - Number(c.reserved);
  const headroom = usable > 0 ? (usable - Number(c.in_use)) / usable : 1;
  if (headroom <= T.CONN_HEADROOM) {
    findings.push(
      `**Connection headroom is ${Math.round(headroom * 100)}%** — ${c.in_use} of ${usable} usable ` +
      `(max_connections ${c.max_connections}, ${c.reserved} superuser-reserved). ` +
      `pg_cron fails with 'connection failed' when this reaches zero.`,
    );
  }

  if (cron.length > 0) {
    const worst = cron[0];
    findings.push(
      `**pg_cron saturation: ${cron.length} fifteen-minute window(s)** in the last 7 days with ` +
      `>= ${T.CRON_FAILURES_15M} failures. Worst: ${worst.bucket} UTC, ${worst.failed} failed ` +
      `(${worst.conn_failed} of them 'connection failed'). See RUNBOOK 3.1.`,
    );
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(
      { findings, scans, statements, connections: c, cron, stats_since: reset[0]?.since }, null, 2));
    process.exitCode = findings.length > 0 ? 2 : 0;
    return;
  }

  const L = [];
  L.push('# Prod cost report');
  L.push('');
  L.push(`Counters accumulated since \`${reset[0]?.since ?? 'unknown'}\`. Read-only.`);
  L.push('');

  if (findings.length === 0) {
    L.push('No thresholds crossed.');
  } else {
    L.push(`## ${findings.length} finding(s)`);
    L.push('');
    for (const f of findings) L.push(`- ${f}`);
  }

  L.push('');
  L.push('## Tables by sequential-scan volume');
  L.push('');
  L.push('| Table | Scans | Tuples read | pg_stat rows | reltuples | Tuples/scan | Heap |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of scans) {
    L.push(`| ${r.table_name} | ${fmt(r.seq_scan)} | ${fmt(r.seq_tup_read)} | ` +
           `${fmt(r.n_live_tup)} | ${fmt(r.reltuples)} | ${fmt(r.tuples_per_scan)} | ${r.heap_size} |`);
  }

  L.push('');
  L.push('## Statements by total database time');
  L.push('');
  L.push('| % of DB time | Calls | Mean ms | Total s | Query |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const r of statements) {
    L.push(`| ${r.pct_of_db_time} | ${fmt(r.calls)} | ${r.mean_ms} | ${fmt(r.total_s)} | ` +
           `\`${String(r.query).replace(/\|/g, '\\|').slice(0, 110)}\` |`);
  }

  L.push('');
  L.push(`## Connections`);
  L.push('');
  L.push(`${c.in_use} in use of ${usable} usable (max ${c.max_connections}, ${c.reserved} reserved) ` +
         `— ${Math.round(headroom * 100)}% headroom.`);

  console.log(L.join('\n'));
  process.exitCode = findings.length > 0 ? 2 : 0;
}

main().catch((e) => {
  console.error('[cost-report]', e.message);
  process.exit(1);
});
