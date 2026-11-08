// bingo-cron Worker.
//
// Cloudflare Cron Triggers fire this Worker's scheduled() handler on the
// configured schedules. For each firing, we fan out HTTP POSTs to the
// matching /api/cron/* routes on the main bingo-web Worker
// (bingoauctions.com) protected by a shared CRON_SECRET header.
//
// Why a separate Worker:
//   1. The main bingo-web Worker is built by @opennextjs/cloudflare and
//      doesn't expose a customizable scheduled() handler without wrapping
//      the auto-generated worker.js (which would get clobbered each build).
//   2. The cron firing is independent of HTTP traffic; a tiny dedicated
//      Worker has near-zero cold-start vs spinning up the 3.5 MiB Next.js
//      bundle just to dispatch some fetches.
//   3. Independent failure modes -- cron errors don't take down the app.

export interface Env {
  CRON_SECRET: string;
  // The base URL of the main Worker (e.g. https://bingoauctions.com).
  CRON_TARGET_URL: string;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Each cron expression maps to the set of /api/cron/* routes to invoke.
// Fan-out is parallel; one path failing doesn't block the others.
//
// Cadence rationale:
//   * * * * *   — notifications + email + auto-charge: time-sensitive,
//                 bidder sees delay if > 1 min; auto-charge needs to fire
//                 fast after lot close so the operator sees settled funds.
//   */2 * * * * — SMS: Twilio rate limits are looser than push; 2-min is fine + cheaper
//   */5 * * * * — closing-soon, saved-searches, health-check: discovery/monitoring, 5-min lag OK
//   */30 * * * * — payment-followups + ai-budget: medium-priority retries + alerting
//   0 * * * *   — settlements-release, grace-expiry: top-of-hour batching
//                 reduces Stripe API calls + lets the 48h grace timer fire
//                 at predictable times for status reporting.
//   0 0 * * *   — operator-sub-lapse: daily flip of past_due operators
//                 whose 7d grace window elapsed. Runs at UTC midnight to
//                 keep audit timestamps tidy.
const SCHEDULES: Record<string, string[]> = {
  '* * * * *': [
    '/api/cron/notifications-drain',
    '/api/cron/email-drain',
    // 0105 auto-charge worker. Pops auto_charge_jobs rows whose
    // next_attempt_at <= now, runs off-session PaymentIntents against
    // the bidder's saved card. Must run frequently so a closed-lot
    // invoice is paid within minutes, not hours.
    '/api/cron/auto-charge-drain',
    // (No refund drain. The Stripe-era /api/cron/refund-jobs-drain was removed
    // in the Square cutover (3c68ca9): /api/invoices/[id]/refund-items now calls
    // Square RefundPayment inline, so refunds are synchronous and never queued.
    // The route never existed on the Square side, so this entry POSTed to a 404
    // every minute. The refund_jobs table has held zero rows in its lifetime —
    // its only producer is the auto_mark_pickup_no_show branch for
    // no_show_policy='refund_minus_restock', which no operator has ever set.)
    // PR-133 / mig 0162 image enrichment worker. Drains image_enrichment_jobs
    // rows produced unconditionally at import time (commitImport). Resolves
    // photo_url for import_rows that arrived with no image or a placeholder
    // ('NA' / 'N/A' / etc.) using Amazon ASIN probe, Open Food Facts, or
    // Open Library by identifier kind. 1-min cadence keeps photos fresh
    // without delaying the import transaction.
    '/api/cron/image-enrichment-drain',
    // Mig 0227 photo re-host worker. Downloads externally-hosted lot photos
    // (legacy S3 / Amazon / Wayfair hotlinks) into our own 'lot-photos'
    // bucket and swaps lots.photo_urls to the internal copies. Watches the
    // lots table, so manifest imports / BRN / AI / manual lots are all
    // covered automatically. Minute cadence: newly imported lots should be
    // on owned storage within minutes; per-tick image budget keeps each
    // run small.
    '/api/cron/photo-rehost',
  ],
  '*/2 * * * *': [
    '/api/cron/sms-drain',
  ],
  '*/5 * * * *': [
    '/api/cron/closing-soon',
    '/api/cron/saved-searches',
    '/api/cron/health-check',
    // Mig 0339 Meta Conversions API drain. Ships the registration / first-bid /
    // purchase outbox to Meta so ad optimisation trains on real conversions.
    // 5-min lag is invisible to Meta -- events carry their own occurred_at and
    // are accepted for 7 days -- and the slower cadence keeps each call well
    // under the 1000-event batch limit at our volume (~240 events/day).
    // No-ops with 'skipped' until a Meta token is on the Worker, so this is
    // safe to run before the credential lands.
    '/api/cron/meta-capi-drain',
    // Fills lots.category_id, which is what the Meta catalog feed sends as
    // product_type and what the storefront browses by. 41% of the live feed
    // had none. Two tiers -- a free exact-name match, then a batched cheap
    // model call -- and it only ever fills a NULL, so it can never overwrite
    // a category a lotter chose. Self-limiting: once the backlog is clear it
    // returns 'nothing uncategorised' and costs one query.
    '/api/cron/lot-categorize',
    // 0477: email the owners about each new feedback item (burst-throttled).
    // No-ops until 0477 is applied.
    '/api/cron/feedback-notify',
  ],
  '*/30 * * * *': [
    // 0477: 07:00 CT digest of feedback still New after 24h; sends once per
    // Chicago day, the 07:30 tick retries a failed send.
    '/api/cron/feedback-digest',
    // Payment-failure dunning. After payment_intent.payment_failed the
    // webhook handler writes a payment_followups row with
    // next_attempt_at = now+24h. This drains overdue rows: sends 2nd
    // reminder at 24h, marks abandoned + relists lots at 72h cumulative.
    '/api/cron/payment-followups',
    // AI budget threshold alerting (migration 0085). Checks each operator's
    // month-to-date AI spend and enqueues notifications at 50/80/100% of
    // their monthly cap. Also emits a Sentry metric for hourly spend
    // monitoring ($5/hr warning, $20/hr error — wire in Sentry dashboard).
    '/api/cron/ai-budget-checks',
    // E2 (mig 0167): Dispute evidence-deadline reminders. Finds open disputes
    // whose evidence_due_by is within 48 hours and notifies operator staff
    // (dispute_evidence_due push). 30-min cadence gives ample lead time.
    '/api/cron/dispute-deadline-reminders',
    // E3 (mig 0167): Pickup window reminders. Finds paid invoices whose
    // pickup window closes within 24 hours and notifies the bidder
    // (pickup_reminder push) before the no-show timer fires.
    '/api/cron/pickup-reminders',
  ],
  '0 * * * *': [
    // Mig 0228 add-card nudge. One-time "add a card to start bidding"
    // email/push to bidders registered >24h with no card on file. Hourly is
    // plenty — the nudge targets a 24h-old signup, so ±1h is invisible.
    '/api/cron/add-card-nudge',
    // Mig 0229 referral-credit earn sweep. Grants $5/$5 once a referred
    // bidder's first invoice is paid AND picked up. Hourly: pickup happens
    // on warehouse hours, nobody needs the credit within the minute.
    '/api/cron/referral-credit-sweep',
    // Mig 0236 Square directory sync + loyalty accrual. No-op while the
    // /marketing toggles are off; hourly drains any backlog within a day.
    // It is also what keeps invoices.square_processing_fee_cents populated,
    // which is the reconciliation that /api/cron/reconcile-payments was once
    // meant to backstop — see the note at the end of this block.
    '/api/cron/square-sync',
    // (No settlement release. /api/cron/settlements-release POSTed here every
    // hour and 404ed: the route was never built on the Square side. Settlement
    // meant moving money from the platform balance out to an operator's Stripe
    // connected account under the separate-charges topology. That topology went
    // away twice over — first to destination charges (2026-05-16, funds route at
    // payment time), then to Square single-account, where BinGo IS the operator
    // and the money lands in its own Square location directly. Verified before
    // removing: public.operator_settlements holds ZERO rows, and zero in
    // 'releasable'. No money is waiting on this. lib/cron/settlements-release.ts
    // is deleted with this change — nothing imported it.)
    // 0105 grace-expiry sweep. Flips invoices in payment_failed_grace
    // whose 48h window elapsed into payment_failed_relisted, applies
    // the $5 relot fee, and releases the lots back into the auto-relist
    // pool from 0097.
    '/api/cron/grace-expiry',
    // (No payment reconciliation. /api/cron/reconcile-payments POSTed here
    // hourly and 404ed — and unlike the other two, this one has no
    // implementation ANYWHERE in the repo: no route, no lib, no history. It was
    // a safety net for a Stripe failure mode, an invoice left pending because
    // payment_intent.succeeded was dropped or late. The Square cutover removed
    // the shape of that bug: auto-charge-drain charges synchronously and marks
    // the invoice in the same call rather than waiting to be told by a webhook.
    // Verified before removing, against prod: 0 invoices carry a
    // square_payment_id without being paid, and 0 invoices sit in 'pending' at
    // all — let alone the >24h stragglers this was written to catch.)
  ],
  '0 14 * * *': [
    // Mig 0230 marketing digest. 14:00 UTC = 9am CDT / 8am CST at the
    // warehouse — morning inbox time. The handler self-gates (dashboard
    // toggle + lots-closing-today + 72h rate limit), so most days no email
    // goes out. Owner explicitly did NOT want nightly.
    '/api/cron/marketing-digest',
    // Mig 0292 segmented campaigns (first-bid nudge, outbid comeback, win-back,
    // second purchase, SMS opt-in). Same morning slot as the digest. Each
    // campaign self-gates on its own cadence + per-bidder frequency cap, and
    // ALL of them ship disabled — this is a no-op until the owner enables one
    // in /marketing. Runs after the digest so a day that sends both does not
    // put two BinGo emails in the same inbox out of order.
    '/api/cron/marketing-campaigns',
  ],
  '0 0 * * *': [
    // 0106 operator-sub-lapse sweep. Flips operators with
    // subscription_status='past_due' AND lapse_at < now() into
    // status='subscription_lapsed' so auction-creation gates can deny.
    '/api/cron/operator-sub-lapse',
  ],
};

async function callRoute(env: Env, path: string): Promise<unknown> {
  const url = `${env.CRON_TARGET_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-cron-secret': env.CRON_SECRET,
      'content-type': 'application/json',
    },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const paths = SCHEDULES[event.cron];
    if (!paths || paths.length === 0) {
      console.log(`[cron-trigger] no paths configured for: ${event.cron}`);
      return;
    }

    // Run all drains in parallel; one failing doesn't block the others.
    // After all settle, if ANY rejected we throw so the Cloudflare Worker
    // run is marked failed. Without this, silent auto-charge failures during
    // auction close mean bidders don't get charged and we don't see it in
    // the Cloudflare Dashboard > Workers > bingo-cron > Logs > Errors view.
    const run = Promise.allSettled(paths.map((p) => callRoute(env, p))).then(
      (results) => {
        const failures: Array<{ path: string; reason: unknown }> = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          const path = paths[i]!;
          if (r.status === 'fulfilled') {
            console.log(`[cron-trigger] ${path} ok`, JSON.stringify(r.value));
          } else {
            console.error(`[cron-trigger] ${path} FAIL: ${(r.reason as Error)?.message ?? String(r.reason)}`);
            failures.push({ path, reason: r.reason });
          }
        }
        if (failures.length > 0) {
          const summary = failures
            .map((f) => `${f.path}: ${(f.reason as Error)?.message ?? String(f.reason)}`)
            .join('; ');
          // Re-throw so Cloudflare marks this scheduled run as failed and
          // surfaces it in the dashboard + invocation logs. The throw
          // propagates through ctx.waitUntil to the runtime.
          throw new Error(
            `[cron-trigger] ${failures.length}/${results.length} drain(s) failed for cron "${event.cron}": ${summary}`,
          );
        }
      },
    );

    ctx.waitUntil(run);
  },
};
