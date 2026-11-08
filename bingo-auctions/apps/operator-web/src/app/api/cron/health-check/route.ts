// POST /api/cron/health-check
// Called every 5 minutes by the bingo-cron Worker.
//
// Checks two signals:
//   1. pg_cron failures in the last 15 minutes — fires a Sentry exception if > 0.
//      Requires the helper RPC `health_check_pg_cron_failures()` in the DB
//      (see migration note below). supabase-js cannot query the `cron` schema
//      directly, so we call an RPC that runs inside the DB and returns the count.
//
//   2. Dead-letter invoice jobs (build_invoice_jobs.attempt_count >= 5) — fires
//      a Sentry exception if any rows exist.
//
// MIGRATION NEEDED (add separately as migration 0085_health_check_rpc.sql):
//
//   create or replace function health_check_pg_cron_failures()
//   returns integer
//   language sql
//   security definer
//   set search_path = cron, public
//   as $$
//     select count(*)::integer
//     from cron.job_run_details
//     where status = 'failed'
//       and start_time > now() - interval '15 minutes';
//   $$;
//
//   grant execute on function health_check_pg_cron_failures() to service_role;
//
// Until that migration runs, the pg_cron check will return { pg_cron_check: 'rpc_missing' }
// and log a warning rather than alerting — the DLQ check still runs.

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkCronSecret } from '@/lib/cron-auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { sendOpsAlert } from '@/lib/ops-alert';
import { buildKillReport, type KillRow, type OtaPublish } from '@/lib/kill-report';

/**
 * Failed pg_cron runs in a 15-minute window that mean "the database is
 * saturated", as opposed to a job having a bad minute.
 *
 * Set from 21 days of cron.job_run_details, not from taste. Peak failures in
 * any 15-minute bucket, by day:
 *
 *     09-12  0      09-15   2      09-18  28   <- saturation
 *     09-13  0      09-16  36  <- saturation   09-19  32   <- the outage
 *     09-14 30  <- saturation   09-17   2
 *
 * The distribution is bimodal with nothing in between: quiet days peak at 0-2,
 * saturation events land at 24-36. Anything from 5 to 20 separates them; 10
 * sits in the middle of that gap.
 *
 * Every one of those saturation events is the same failure — Postgres out of
 * connection slots (177 'connection failed' vs 44 'job startup timeout' over
 * the 21 days). They began 09-14 and, until 09-19, all resolved inside two
 * minutes on their own:
 *
 *     09-14 09:02  28 failures   1 min
 *     09-14 19:12  30 failures   1 min
 *     09-16 14:00  36 failures   2 min
 *     09-16 16:21  11 failures   5 min
 *     09-18 08:23  28 failures   1 min
 *     09-19 19:36  59 failures  24 min   <- customers noticed this one
 *
 * So this threshold is not tuned to catch the outage after the fact. It would
 * have paged on 09-14, twice, five days before the site went down — and again
 * on 09-16 and 09-18. The warning was in the data the whole time and had no
 * way to reach anyone.
 */
const PG_CRON_OUTAGE_THRESHOLD = 10;

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const supabase = getSupabaseAdmin();
  let ok = true;
  let failedPgCronJobs: number | string = 0;
  let abandonedJobs = 0;

  // --- 1. pg_cron failure check (via DB-side RPC) ---
  //
  // 2026-09-19: this check WORKED and nobody heard it. The site was unusable
  // for 45 minutes during the close hour; the rolling 15-minute failure count
  // this RPC returns went 7 → 20 → 27 → 37 → 36 → 32 across the incident, so
  // the check fired on every 5-minute tick for the better part of an hour. We
  // still found out from a customer, because:
  //
  //   1. it reported to Sentry ONLY. Checks 3-5 below call sendOpsAlert and
  //      land in the owner's inbox; this one never did, and nobody watches
  //      Sentry out of hours.
  //   2. `> 0` is not an outage signal. Days carry a dribble of transient
  //      failures, so a >0 alert that DID email would be noise and get
  //      filtered — the alert would exist and still not work.
  //
  // So: Sentry keeps every occurrence for history, and email fires only when
  // the rate says "outage, now" rather than "a job blipped". The threshold is
  // set from measured behaviour, not taste — see PG_CRON_OUTAGE_THRESHOLD.
  try {
    const { data, error } = await supabase.rpc('health_check_pg_cron_failures');
    if (error) {
      // RPC not yet installed (pre-migration) — warn but don't alert.
      console.warn('[health-check] health_check_pg_cron_failures RPC not available:', error.message);
      failedPgCronJobs = 'rpc_missing';
    } else {
      failedPgCronJobs = typeof data === 'number' ? data : 0;
      if (failedPgCronJobs > 0) {
        Sentry.captureException(
          new Error(`pg_cron: ${failedPgCronJobs} failed job(s) in last 15 minutes`),
          {
            level: 'error',
            tags: { cron_route: 'health-check', check: 'pg_cron' },
            extra: { failed_pg_cron_jobs: failedPgCronJobs },
          },
        );
        ok = false;
      }
      if (failedPgCronJobs >= PG_CRON_OUTAGE_THRESHOLD) {
        // Deliberately the same throttle contract as every other ops alert:
        // one email per hour while it persists, so a two-hour incident is two
        // emails, not twenty-four.
        await sendOpsAlert(
          supabase,
          'pg_cron_failure_spike',
          `Scheduled jobs are failing: ${failedPgCronJobs} in the last 15 minutes`,
          `pg_cron recorded ${failedPgCronJobs} failed job runs in the last 15 minutes ` +
            `(normal is 0-${PG_CRON_OUTAGE_THRESHOLD - 1}). At this rate the auction engine is not keeping up: ` +
            `finalize_due_lots and open_due_lots are what close and open lots, so ` +
            `bidders may be seeing a site that does not respond and lots that do not close.\n\n` +
            `This is usually database saturation rather than a broken job. Check, in order:\n` +
            `  1. Failure messages — 'connection failed' means Postgres is out of ` +
            `connection slots; 'job startup timeout' means it is out of background workers.\n` +
            `     select start_time, status, return_message from cron.job_run_details\n` +
            `      where start_time > now() - interval '30 minutes' and status <> 'succeeded'\n` +
            `      order by start_time desc;\n` +
            `  2. Whether a close hour is in progress — the 2026-09-19 outage was the ` +
            `evening close saturating the instance, and it cleared on its own at the end of the hour.\n` +
            `  3. pg_stat_activity for a query holding connections.\n\n` +
            `Background: the 2026-09-19 incident ran 19:12-20:09 Central and was found by a customer, ` +
            `not by this alert — which fired on Sentry the whole time.`,
          // The one check that also pages by SMS. On 2026-09-20 this alert
          // fired correctly at 19:06:05 — one minute after the first failure —
          // and the owner read it at 19:31, by which time the burst had been
          // over for 22 minutes. The whole event lasted four minutes. Email
          // cannot page anyone inside a window that short no matter how fast
          // the check is, so the check is not what needed fixing.
          { sms: true },
        );
      }
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { cron_route: 'health-check', check: 'pg_cron' } });
    ok = false;
  }

  // --- 2. Dead-letter invoice jobs check ---
  //
  // An abandoned build_invoice_job is money we did not collect: the auction
  // closed, the lots are won, and the invoice that would charge the card was
  // never built. It gets an email for the same reason the payments watchdog
  // does — and until now it had none. Like the pg_cron check above it reported
  // to Sentry alone, and no SENTRY_DSN has ever been set on this deployment,
  // so it has reported nowhere at all since it shipped.
  //
  // Threshold is `> 0`, not the >= 3 the crash checks use, because one stuck
  // invoice is already a customer who was not charged — there is no noise
  // floor to clear. Safe to arm: build_invoice_jobs holds 0 rows on prod
  // today, and 0 have ever reached attempt_count >= 5, so this does not fire
  // on a standing backlog the moment it ships.
  try {
    const { count, error } = await supabase
      .from('build_invoice_jobs')
      .select('auction_id', { count: 'exact', head: true })
      .gte('attempt_count', 5);

    if (error) {
      // Table may not exist in all environments — skip gracefully.
      console.warn('[health-check] build_invoice_jobs query failed:', error.message);
    } else {
      abandonedJobs = count ?? 0;
      if (abandonedJobs > 0) {
        Sentry.captureException(
          new Error(`DLQ: ${abandonedJobs} invoice job(s) have attempt_count >= 5 and will not retry`),
          {
            level: 'error',
            tags: { cron_route: 'health-check', check: 'dlq' },
            extra: { abandoned_jobs: abandonedJobs },
          },
        );
        ok = false;
        await sendOpsAlert(
          supabase,
          'invoice_dlq',
          `${abandonedJobs} invoice(s) failed to build and have stopped retrying`,
          `build_invoice_jobs has ${abandonedJobs} row(s) at attempt_count >= 5. The drain will not ` +
            `pick these up again, so each one is a closed auction whose invoice was never built — ` +
            `the winners have not been charged and cannot pay.\n\n` +
            `This does not resolve itself. To see which auctions and why:\n` +
            `  select auction_id, attempt_count, last_attempt_at, last_error\n` +
            `    from build_invoice_jobs where attempt_count >= 5 order by last_attempt_at desc;\n\n` +
            `last_error usually names the cause. Fix it, then reset attempt_count to 0 to let the ` +
            `drain retry. Note the table is normally EMPTY — a non-zero count is itself the signal.`,
        );
      }
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { cron_route: 'health-check', check: 'dlq' } });
    ok = false;
  }

  // --- 3. Auto-charge failure spike (0215 payments watchdog) ---
  // attempt_count >= 2 means at least two consecutive Square charge failures
  // for an invoice — one is noise (card declined), a pile of them is an
  // outage (bad param, dead key, Square incident). Both prior payment
  // outages (automatic_tax 06-02, idempotency-key 06-30) would have tripped
  // this within minutes instead of running for days.
  let failingCharges = 0;
  try {
    const { count, error } = await supabase
      .from('auto_charge_jobs')
      .select('invoice_id', { count: 'exact', head: true })
      .gte('attempt_count', 2);
    if (!error) {
      failingCharges = count ?? 0;
      if (failingCharges >= 3) {
        ok = false;
        await sendOpsAlert(
          supabase,
          'auto_charge_failures',
          `Payments watchdog: ${failingCharges} invoice(s) have failed auto-charge 2+ times`,
          `auto_charge_jobs has ${failingCharges} rows with attempt_count >= 2. ` +
            `Check the Square dashboard and the ops page. Both prior payment outages presented exactly like this.`,
        );
      }
    }
  } catch (err) {
    console.error('[health-check] auto-charge check failed', (err as Error).message);
  }

  // --- 4. Client crash spike (0215 Layer-1 telemetry) ---
  //
  // Counted in TWO buckets since the session watchdog started writing here
  // (2026-08-18). They are different incidents and need different responses,
  // and lumping them together produced a real false alarm on 2026-08-20: three
  // ordinary background kills were reported to the owner as "3 fatal JS errors"
  // with a suggestion to roll back an OTA that was working fine.
  //
  //   is_fatal = true   a JS error was thrown and caught. Code is broken. A
  //                     rollback is a legitimate response.
  //   is_fatal = false  the process vanished with no JS error — iOS reclaiming
  //                     a backgrounded app. A rollback changes nothing; the
  //                     lever is the app's memory footprint.
  let recentCrashes = 0;
  let recentSilentExits = 0;
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count: fatalCount, error: fatalErr } = await supabase
      .from('client_crash_reports')
      .select('id', { count: 'exact', head: true })
      .eq('is_fatal', true)
      .gte('created_at', since);

    if (!fatalErr) {
      recentCrashes = fatalCount ?? 0;
      if (recentCrashes >= 3) {
        ok = false;
        await sendOpsAlert(
          supabase,
          'client_crashes',
          `Crash spike: ${recentCrashes} JS crash(es) in the last hour`,
          `client_crash_reports logged ${recentCrashes} FATAL JS errors in the last 60 minutes. ` +
            `Query the table for message/stack — an OTA rollback may be needed.`,
        );
      }
    }

    // Silent exits (is_fatal=false) are mostly the OS reclaiming a backgrounded
    // app; the threshold is high so we only email on abnormal volume. The
    // client_silent_exits email is plain-English first (staff vs customer,
    // on-screen vs not, recent EAS publish from ota_publishes) with device and
    // raw-row detail below — separate throttle key from fatal JS crashes.
    const { data: silent, error: silentErr } = await supabase
      .from('client_crash_reports')
      .select(
        'created_at, app, platform, device_model, os_version, ota_update, screen, message',
      )
      .eq('is_fatal', false)
      .gte('created_at', since);

    if (!silentErr) {
      recentSilentExits = silent?.length ?? 0;
      if (recentSilentExits >= 10) {
        ok = false;

        const yesterdayStart = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const yesterdayEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: yesterdaySilent } = await supabase
          .from('client_crash_reports')
          .select('id', { count: 'exact', head: true })
          .eq('is_fatal', false)
          .gte('created_at', yesterdayStart)
          .lt('created_at', yesterdayEnd);

        const publishSince = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
        let publishes: OtaPublish[] = [];
        const { data: pubRows, error: pubErr } = await supabase
          .from('ota_publishes')
          .select('app, branch, group_id, update_ids, published_at')
          .gte('published_at', publishSince);
        if (pubErr) {
          console.warn('[health-check] ota_publishes query failed:', pubErr.message);
        } else {
          publishes = (pubRows ?? []) as OtaPublish[];
        }

        const report = buildKillReport({
          now: new Date(),
          rows: (silent ?? []) as KillRow[],
          yesterdaySameHour: yesterdaySilent ?? 0,
          publishes,
        });

        await sendOpsAlert(
          supabase,
          'client_silent_exits',
          report.subject,
          report.text,
        );
      }
    }
  } catch (err) {
    console.error('[health-check] crash check failed', (err as Error).message);
  }

  // --- 5. Handover invariant violations (0357) ---
  //
  // check_collected_item_invariants() runs in pg_cron every 15 minutes and
  // writes one row per (check, lot) where a lot a customer already carried out
  // was reclaimed, relisted, or promised to a second buyer — the 2026-09-14
  // audit's whole class, derived from the raw tables rather than trusting the
  // guards. The DB cannot send email, so this route drains the 'page' rows
  // nobody has been told about yet. notified_at is stamped only after Resend
  // accepts the message; a throttled or failed send leaves the rows queued
  // for the next tick instead of losing them.
  let invariantPending = 0;
  let invariantEmailed = 0;
  try {
    const { data: rows, error } = await supabase
      .from('invariant_violations')
      .select('id, check_code, details, first_seen_at')
      .eq('severity', 'page')
      .is('resolved_at', null)
      .is('acknowledged_at', null)
      .is('notified_at', null)
      .order('first_seen_at', { ascending: true })
      .limit(50);
    if (error) {
      // Table absent until 0357 is applied — warn, don't alert.
      console.warn('[health-check] invariant_violations query failed:', error.message);
    } else {
      const pending = (rows ?? []) as InvariantRow[];
      invariantPending = pending.length;
      if (pending.length > 0) {
        ok = false;
        const sent = await sendOpsAlert(
          supabase,
          'collected_item_invariants',
          `Handover invariant: ${pending.length} new violation(s) — an item a customer already took is back in play`,
          pending.map(describeViolation).join('\n') +
            '\n\nEvery row with its action is on /reports/health (Handover invariants). ' +
            'Background: docs/audits/flagged-items-pickup-forfeit-relist-2026-09-14.md.',
        );
        if (sent) {
          const ids = pending.map((r) => r.id);
          const { error: markErr } = await supabase
            .from('invariant_violations')
            .update({ notified_at: new Date().toISOString() })
            .in('id', ids);
          if (markErr) {
            console.error('[health-check] could not stamp notified_at', markErr.message);
          } else {
            invariantEmailed = ids.length;
          }
        }
      }
    }
  } catch (err) {
    console.error('[health-check] invariant check failed', (err as Error).message);
  }

  return NextResponse.json({
    ok,
    failed_pg_cron_jobs: failedPgCronJobs,
    abandoned_jobs: abandonedJobs,
    failing_charges: failingCharges,
    recent_crashes: recentCrashes,
    recent_silent_exits: recentSilentExits,
    invariant_pending: invariantPending,
    invariant_emailed: invariantEmailed,
    checked_at: new Date().toISOString(),
  });
}

// One row of invariant_violations as the email drain reads it.
type InvariantRow = {
  id: number;
  check_code: string;
  details: Record<string, unknown> | null;
  first_seen_at: string;
};

// Only 'page' severities reach email; the 'watch' checks stay on the page.
const CHECK_LABEL: Record<string, string> = {
  collected_lot_reclaimed: 'A collected item was put back into stock',
  collected_lot_reclaim_refused: 'A write tried to put a collected item back into stock (skipped, nothing changed)',
  collected_lineage_relisted: 'A collected item was relisted',
  second_buyer_promise: 'A collected item has been sold to a second buyer',
  no_show_sweep_stalled: 'The no-show sweep has not completed in 90 minutes',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Plain text, one line per violation, written for the owner's inbox: which
// box, when the first buyer took it, and what to do about it.
function describeViolation(r: InvariantRow): string {
  const d = r.details ?? {};
  const label = CHECK_LABEL[r.check_code] ?? r.check_code;
  const lot = str(d.lot);
  const root = str(d.root_lot);
  const collected = str(d.collected_at)?.slice(0, 10) ?? null;
  const action = str(d.action) ?? '';
  const parts = [
    lot,
    root && root !== lot ? `(the box was ${root} when the first buyer took it)` : null,
    collected ? `collected ${collected}` : null,
  ].filter(Boolean);
  return `- ${label}${parts.length ? ': ' + parts.join(', ') : ''}. ${action}`.trim();
}
