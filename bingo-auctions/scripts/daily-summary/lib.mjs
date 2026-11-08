// Daily summary email — pure parts: SQL, guards, rendering, the send gate.
// I/O (Supabase SQL, GitHub API, Resend) lives in scripts/daily-summary.mjs so
// everything here can be tested with fake rows.
//
// Read-only by construction: every query below is a single SELECT/WITH, and
// assertReadOnly() refuses anything else before it leaves the process.

export const TZ = 'America/Chicago';
export const MAX_ITEMS = 10;
const OPEN_FEEDBACK = "('new', 'triaged', 'planned')";

/** Refuse anything that is not one SELECT/WITH statement. */
export function assertReadOnly(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('daily-summary: only SELECT/WITH queries are allowed');
  if (sql.includes(';')) throw new Error('daily-summary: one statement per query (no semicolons)');
  return sql;
}

/** Blank out long digit runs (a card or account number typed into feedback). */
export function redactNumbers(text) {
  return String(text ?? '').replace(/\d(?:[\s-]?\d){11,}/g, '[number removed]');
}

/** One line, redacted, at most n characters. */
export function shortText(text, n = 140) {
  const one = redactNumbers(text).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function chicagoDay(date) {
  return new Date(date).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
}

function chicagoHour(date) {
  return Number(new Date(date).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24;
}

/**
 * Scheduled runs fire at 11:45 and 12:45 UTC; exactly one of those is 06:45 in
 * Chicago on any given day (CDT: 11:45, CST: 12:45). GitHub starts scheduled
 * runs 12–19 minutes late, so the email lands around 7:00. The slot is taken
 * from the cron string, not the clock, so a late start still picks correctly.
 */
export function shouldSendScheduled(cron, now = new Date()) {
  const m = /^(\d+) (\d+) /.exec(String(cron ?? ''));
  if (!m) return false;
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[2]), Number(m[1])));
  return chicagoHour(slot) === 6;
}

export function parseRecipients(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const QUERIES = {
  feedback: `
    SELECT
      (SELECT count(*) FROM app_feedback WHERE created_at > now() - interval '24 hours') AS new_count,
      (SELECT count(*) FROM app_feedback WHERE status IN ${OPEN_FEEDBACK}) AS open_count,
      (SELECT min(created_at) FROM app_feedback WHERE status IN ${OPEN_FEEDBACK}) AS oldest_open,
      (SELECT coalesce(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) FROM (
         SELECT created_at, app, kind, left(message, 400) AS message
         FROM app_feedback WHERE created_at > now() - interval '24 hours'
         ORDER BY created_at DESC LIMIT ${MAX_ITEMS}) x) AS items`,

  auctions: `
    SELECT
      count(DISTINCT auction_id) AS auctions,
      count(*) AS closed,
      count(*) FILTER (WHERE status = 'won') AS sold,
      count(*) FILTER (WHERE status = 'unsold') AS unsold
    FROM lots WHERE closed_at > now() - interval '24 hours' AND deleted_at IS NULL`,

  // Invoices with a declined/errored charge attempt in the last 24h. Only the
  // invoice id, auction title and current status leave the database: no
  // amounts, card facts or processor text.
  failedCharges: `
    WITH f AS (
      SELECT ca.invoice_id, max(ca.attempted_at) AS last_failed
      FROM charge_attempts ca
      WHERE ca.attempted_at > now() - interval '24 hours' AND ca.outcome IN ('declined', 'error')
      GROUP BY ca.invoice_id)
    SELECT
      (SELECT count(*) FROM f) AS failed_invoices,
      (SELECT count(*) FROM f JOIN invoices i ON i.id = f.invoice_id
        WHERE i.status NOT IN ('paid', 'refunded', 'partially_refunded', 'canceled')) AS still_unpaid,
      (SELECT coalesce(jsonb_agg(x ORDER BY x.last_failed DESC), '[]'::jsonb) FROM (
         SELECT f.invoice_id, f.last_failed, i.status::text AS status, a.title AS auction
         FROM f JOIN invoices i ON i.id = f.invoice_id LEFT JOIN auctions a ON a.id = i.auction_id
         ORDER BY f.last_failed DESC LIMIT ${MAX_ITEMS}) x) AS items`,

  stuckDrafts: `
    WITH s AS (
      SELECT l.id, l.lot_code, l.title, l.created_at
      FROM lots l JOIN auctions a ON a.id = l.auction_id
      WHERE l.status = 'draft' AND l.deleted_at IS NULL AND a.status IN ('closed', 'canceled'))
    SELECT
      (SELECT count(*) FROM s) AS stuck,
      (SELECT coalesce(jsonb_agg(x ORDER BY x.created_at), '[]'::jsonb) FROM (
         SELECT id, lot_code, left(title, 80) AS title, created_at FROM s ORDER BY created_at LIMIT ${MAX_ITEMS}) x) AS items`,

  // "In limbo" as of time T: refunded by T, and by T not picked up, deleted,
  // removed, relotted (no child lot yet) or moved to relisted/disposed/canceled.
  // T = now and T = 24h ago give today's count and yesterday's, from the
  // timestamps already stored — the job keeps no state of its own.
  refundLimbo: `
    WITH r AS (
      SELECT il.lot_id, coalesce(il.refunded_at, i.refunded_at) AS refunded_at, il.picked_up_at,
             row_number() OVER (PARTITION BY il.lot_id ORDER BY coalesce(il.refunded_at, i.refunded_at) DESC NULLS LAST) AS rn
      FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
      WHERE il.refunded_at IS NOT NULL OR i.status = 'refunded'),
    t(label, at) AS (VALUES ('now', now()), ('day_ago', now() - interval '24 hours')),
    limbo AS (
      SELECT t.label, l.id, l.lot_code, l.title, r.refunded_at
      FROM t JOIN r ON r.rn = 1 AND r.refunded_at <= t.at
      JOIN lots l ON l.id = r.lot_id
      WHERE (r.picked_up_at IS NULL OR r.picked_up_at > t.at)
        AND (l.deleted_at IS NULL OR l.deleted_at > t.at)
        AND (l.removal_kind IS NULL OR l.removed_at > t.at)
        AND NOT EXISTS (SELECT 1 FROM lots c WHERE c.relisted_from_lot_id = l.id AND c.created_at <= t.at)
        AND coalesce(
              (SELECT h.to_status FROM lot_status_history h
                WHERE h.lot_id = l.id AND h.changed_at <= t.at ORDER BY h.changed_at DESC LIMIT 1),
              l.status::text) NOT IN ('relisted', 'disposed', 'canceled'))
    SELECT
      (SELECT count(*) FROM limbo WHERE label = 'now') AS now_count,
      (SELECT count(*) FROM limbo WHERE label = 'day_ago') AS day_ago_count,
      (SELECT coalesce(jsonb_agg(x ORDER BY x.refunded_at), '[]'::jsonb) FROM (
         SELECT id, lot_code, left(title, 80) AS title, refunded_at FROM limbo
         WHERE label = 'now' ORDER BY refunded_at LIMIT ${MAX_ITEMS}) x) AS items`,

  cronFailures: `
    SELECT j.jobname, count(*) AS failed, max(d.start_time) AS last_failed
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time > now() - interval '24 hours' AND d.status = 'failed'
    GROUP BY j.jobname ORDER BY count(*) DESC`,
};

for (const sql of Object.values(QUERIES)) assertReadOnly(sql);

// ── GitHub runs ──────────────────────────────────────────────────────────────

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** Failed post-deploy checks and failed scheduled workflows, from a runs listing. */
export function failedRuns(runs, { sinceMs, selfRunId } = {}) {
  return (runs ?? []).filter(
    (r) =>
      FAILED.has(r.conclusion) &&
      String(r.id) !== String(selfRunId ?? '') &&
      (sinceMs == null || Date.parse(r.created_at) >= sinceMs) &&
      (r.event === 'schedule' || String(r.path ?? '').endsWith('post-deploy-check.yml')),
  );
}

// ── Rendering ────────────────────────────────────────────────────────────────

const n = (v) => Number(v ?? 0);

function list(lines, items, format, moreCount, moreHint) {
  for (const it of items.slice(0, MAX_ITEMS)) lines.push(`- ${format(it)}`);
  if (moreCount > 0) lines.push(`and ${moreCount} more${moreHint ? `: ${moreHint}` : ''}`);
}

const daysSince = (at, now) => Math.max(0, Math.floor((now - Date.parse(at)) / 86_400_000));

/**
 * Each section returns { title, lines, attention }. `data` is the section's
 * loaded rows, or an Error when its query failed.
 */
export const SECTIONS = [
  {
    key: 'feedback',
    title: 'CUSTOMER FEEDBACK',
    render(d, { site, now }) {
      const newCount = n(d.new_count);
      const lines = [
        `New since yesterday: ${newCount} · Open: ${n(d.open_count)}` +
          (d.oldest_open ? ` · Oldest open: ${daysSince(d.oldest_open, now)} days` : ''),
      ];
      const more = newCount - Math.min(newCount, (d.items ?? []).length);
      list(
        lines,
        d.items ?? [],
        (it) => `${chicagoDay(it.created_at)} · ${it.app} ${it.kind} · "${shortText(it.message)}"`,
        more,
        `${site}/feedback`,
      );
      if (newCount > 0 && more === 0) lines.push(`Review: ${site}/feedback`);
      return { lines, attention: newCount };
    },
  },
  {
    key: 'auctions',
    title: "LAST NIGHT'S AUCTIONS",
    render(d, { site }) {
      const a = d.auctions;
      const f = d.failedCharges;
      const lines = [];
      if (a instanceof Error) lines.push("Lots closed: couldn't load");
      else lines.push(`${n(a.auctions)} auctions · ${n(a.closed)} lots closed · ${n(a.sold)} sold · ${n(a.unsold)} unsold`);
      let attention = 0;
      if (f instanceof Error) lines.push("Failed card charges: couldn't load");
      else {
        const failed = n(f.failed_invoices);
        attention = n(f.still_unpaid);
        lines.push(`Failed card charges: ${failed} invoice${failed === 1 ? '' : 's'}` + (failed ? ` (${attention} still unpaid)` : ''));
        list(
          lines,
          f.items ?? [],
          (it) =>
            `${chicagoDay(it.last_failed)} · invoice ${String(it.invoice_id).slice(0, 8)}` +
            `${it.auction ? ` · ${shortText(it.auction, 60)}` : ''} · ${it.status} · ${site}/invoices/${it.invoice_id}`,
          failed - Math.min(failed, (f.items ?? []).length),
          `${site}/invoices`,
        );
      }
      return { lines, attention };
    },
  },
  {
    key: 'stuckDrafts',
    title: 'STUCK ITEMS (Draft lots in closed auctions, should be 0)',
    render(d, { site }) {
      const stuck = n(d.stuck);
      const lines = [`${stuck}`];
      list(
        lines,
        d.items ?? [],
        (it) => `${it.lot_code} · ${shortText(it.title, 60)} · ${site}/lots/${it.id}`,
        stuck - Math.min(stuck, (d.items ?? []).length),
        'no admin page lists these yet',
      );
      return { lines, attention: stuck };
    },
  },
  {
    key: 'refundLimbo',
    title: 'REFUNDED ITEMS WITH NO NEXT STEP',
    render(d, { site, now }) {
      const count = n(d.now_count);
      const delta = count - n(d.day_ago_count);
      const lines = [`${count} (${delta > 0 ? '+' : ''}${delta} since yesterday)`];
      list(
        lines,
        d.items ?? [],
        (it) => `${it.lot_code} · ${shortText(it.title, 60)} · refunded ${daysSince(it.refunded_at, now)} days ago · ${site}/lots/${it.id}`,
        count - Math.min(count, (d.items ?? []).length),
        'no admin page lists these yet',
      );
      return { lines, attention: Math.max(0, delta) };
    },
  },
  {
    key: 'failures',
    title: 'FAILURES (last 24h)',
    render(d) {
      const lines = [];
      let attention = 0;
      if (d.cron instanceof Error) lines.push("Database jobs: couldn't load");
      else
        for (const j of d.cron ?? []) {
          attention += 1;
          lines.push(`- database job ${j.jobname}: ${n(j.failed)} failed, last ${new Date(j.last_failed).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}`);
        }
      if (d.runs instanceof Error) lines.push("GitHub jobs: couldn't load");
      else
        for (const r of d.runs ?? []) {
          attention += 1;
          lines.push(`- ${r.name}: ${r.conclusion} · ${r.html_url}`);
        }
      if (!lines.length) lines.push('None.');
      return { lines, attention };
    },
  },
];

/** Build { subject, text, attention, counts } from loaded section data. */
export function buildEmail(data, { site, now = new Date() }) {
  const parts = [];
  const counts = {};
  let attention = 0;
  SECTIONS.forEach((s, i) => {
    const d = data[s.key];
    let out;
    if (d instanceof Error || d == null) out = { lines: ["couldn't load"], attention: 0 };
    else {
      try {
        out = s.render(d, { site, now });
      } catch {
        out = { lines: ["couldn't load"], attention: 0 };
      }
    }
    counts[s.key] = out.lines[0] === "couldn't load" ? 'failed' : out.attention;
    attention += out.attention;
    parts.push(`${i + 1}. ${s.title}\n${out.lines.join('\n')}`);
  });
  const day = chicagoDay(now);
  const head = attention === 0 ? 'Nothing new today.\n\n' : '';
  const text =
    `BinGo Daily · ${day}\n\n${head}${parts.join('\n\n')}\n\n` +
    `Read-only report from .github/workflows/daily-summary.yml. Times are Central.\n`;
  return { subject: `BinGo Daily - ${day} - ${attention} need attention`, text, attention, counts };
}
