// Pickup window reminder scanner (E3).
//
// Finds paid invoices whose pickup window (COALESCE(pickups.scheduled_at,
// auctions.pickup_ends_at)) closes within ~24 hours and whose bidder has
// NOT yet been reminded. Enqueues one `pickup_reminder` push per invoice.
//
// `pickup_reminder` notification_kind is added in mig 0167.
// The drain case is added in the same PR in notifications-drain.ts.
//
// Schema note: there is no pickups.pickup_ends_at column. The pickup deadline
// is COALESCE(pickups.scheduled_at, auctions.pickup_ends_at), matching the
// same expression used by auto_mark_pickup_no_show (migs 0155/0158/0159).
//
// Cadence: every 30 minutes (see apps/cron-trigger/src/index.ts). At 30-min
// cadence the reminder fires 24–24.5 hours before the window closes —
// well ahead of the no-show threshold.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { bidderDeepLink } from '@/lib/app-links';

// Send the reminder when the window closes within this many hours.
const REMIND_HOURS_BEFORE = 24;

type PickupReminderRow = {
  invoice_id: string;
  bidder_id: string;
  deadline: string; // COALESCE result
};

export type PickupRemindersResult = {
  scanned: number;
  enqueued: number;
};

export async function runPickupReminders(): Promise<PickupRemindersResult> {
  const supabase = getSupabaseAdmin();

  const now = new Date().toISOString();
  const windowEnd = new Date(
    Date.now() + REMIND_HOURS_BEFORE * 60 * 60 * 1000,
  ).toISOString();

  // Find pickups whose effective deadline falls within the next 24h and that
  // are still pending (not yet picked up, not already no-show).
  // We use a raw SQL query via rpc or chain selects. supabase-js can't express
  // COALESCE across a joined column in a filter, so we do a two-step approach:
  //
  // Step 1: fetch candidate pickups with their invoices + auction deadline.
  // We JOIN through invoices to get bidder_id + auction_id, then through
  // auctions to get pickup_ends_at as the fallback.
  //
  // Since supabase-js select() doesn't support COALESCE in filters, we fetch
  // a broader set (pickups.scheduled_at IS NOT NULL within window OR
  // pickups.scheduled_at IS NULL) and filter in-process. The set is bounded
  // by the number of active auctions with live pickups — small in practice.
  const { data: rawRows, error } = await supabase
    .from('pickups')
    .select(
      'invoice_id, scheduled_at, status, invoices(id, bidder_id, status, auction_id, auctions(id, pickup_ends_at))',
    )
    .in('status', ['pending', 'scheduled'])
    .returns<
      Array<{
        invoice_id: string;
        scheduled_at: string | null;
        status: string;
        invoices: {
          id: string;
          bidder_id: string;
          status: string;
          auction_id: string;
          auctions: {
            id: string;
            pickup_ends_at: string;
          } | null;
        } | null;
      }>
    >();

  if (error) {
    console.error('[pickup-reminders] query error:', error.message);
    return { scanned: 0, enqueued: 0 };
  }

  const raw = rawRows ?? [];

  // Filter: only paid invoices whose effective deadline is within the window.
  const nowMs = Date.now();
  const windowEndMs = nowMs + REMIND_HOURS_BEFORE * 60 * 60 * 1000;

  const candidates: PickupReminderRow[] = [];
  for (const row of raw) {
    const invoice = row.invoices;
    if (!invoice || invoice.status !== 'paid') continue;
    const auctionDeadline = invoice.auctions?.pickup_ends_at;
    const deadline = row.scheduled_at ?? auctionDeadline ?? null;
    if (!deadline) continue;
    const deadlineMs = new Date(deadline).getTime();
    if (deadlineMs > nowMs && deadlineMs <= windowEndMs) {
      candidates.push({
        invoice_id: invoice.id,
        bidder_id: invoice.bidder_id,
        deadline,
      });
    }
  }

  if (candidates.length === 0) {
    return { scanned: raw.length, enqueued: 0 };
  }

  // Check which invoices were already reminded.
  const idempotencyKeys = candidates.map(
    (c) => `pickup_reminder:${c.invoice_id}`,
  );

  const { data: existing } = await supabase
    .from('notifications_outbox')
    .select('idempotency_key')
    .in('idempotency_key', idempotencyKeys);

  const alreadySent = new Set<string>(
    ((existing ?? []) as Array<{ idempotency_key: string }>).map(
      (r) => r.idempotency_key,
    ),
  );

  const toNotify = candidates.filter(
    (c) => !alreadySent.has(`pickup_reminder:${c.invoice_id}`),
  );

  let enqueued = 0;

  for (const c of toNotify) {
    const { error: insertErr } = await supabase
      .from('notifications_outbox')
      .insert({
        target_user_id: c.bidder_id,
        kind: 'pickup_reminder',
        idempotency_key: `pickup_reminder:${c.invoice_id}`,
        payload: {
          invoice_id: c.invoice_id,
          pickup_deadline: c.deadline,
          // 2026-09-14: was clovrbid://, a scheme no installed build registers
          // — the reminder tap was inert. See bidderDeepLink().
          deep_link: bidderDeepLink(`pickup/${c.invoice_id}`),
        },
      });

    if (insertErr && insertErr.code !== '23505') {
      console.warn(
        '[pickup-reminders] insert error for invoice',
        c.invoice_id,
        insertErr.message,
      );
    } else if (!insertErr) {
      enqueued++;
    }
  }

  return { scanned: raw.length, enqueued };
}
