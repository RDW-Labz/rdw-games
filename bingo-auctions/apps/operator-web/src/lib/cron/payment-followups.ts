// Payment-failure dunning cron.
//
// Walks `payment_followups` (migration 0077) for invoices where a
// PaymentIntent failed and the next-attempt window has elapsed. The
// schedule:
//
//   attempt 1 (immediately on PI failure): first notification +
//     payment_followups row inserted with next_attempt_at = now+24h.
//     [done by webhook handler in webhooks/stripe/route.ts]
//
//   attempt 2 (now+24h): 2nd reminder notification + reschedule
//     next_attempt_at = now+48h (so 72h cumulative).
//
//   attempt 3 (now+72h cumulative): bidder abandoned. Mark invoice
//     unpaid_no_show, flip lot status to 'relisted', enqueue
//     lot_relisted_no_show notification, mark final_status='abandoned'.
//
// Idempotent: re-entry just rescans the table. Each notification
// outbox row has an idempotency_key embedded in the row itself
// (notifications_outbox UNIQUE constraint protects against dupes).

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { bidderDeepLink } from '@/lib/app-links';

export type FollowupsResult = {
  scanned: number;
  reminded: number;
  abandoned: number;
  errors: number;
};

const REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48h between reminder and abandon
const BATCH_SIZE = 100;

type FollowupRow = {
  invoice_id: string;
  attempt_count: number;
  next_attempt_at: string;
};

type InvoiceForFollowup = {
  id: string;
  status: string;
  bidder_id: string;
  operator_id: string;
};

export async function runPaymentFollowups(): Promise<FollowupsResult> {
  const supabase = getSupabaseAdmin();
  const now = new Date();

  // Pull all in-flight followups whose next-attempt window has elapsed.
  const { data: rows, error } = await supabase
    .from('payment_followups')
    .select('invoice_id, attempt_count, next_attempt_at')
    .is('final_status', null)
    .lt('next_attempt_at', now.toISOString())
    .limit(BATCH_SIZE)
    .returns<FollowupRow[]>();

  if (error) {
    console.error('[payment-followups] select failed:', error.message);
    return { scanned: 0, reminded: 0, abandoned: 0, errors: 1 };
  }
  if (!rows || rows.length === 0) {
    return { scanned: 0, reminded: 0, abandoned: 0, errors: 0 };
  }

  // Resolve all invoices in one query.
  const invoiceIds = rows.map((r) => r.invoice_id);
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, status, bidder_id, operator_id')
    .in('id', invoiceIds)
    .returns<InvoiceForFollowup[]>();

  const byId = new Map<string, InvoiceForFollowup>(
    (invoices ?? []).map((i) => [i.id, i]),
  );

  let reminded = 0;
  let abandoned = 0;
  let errors = 0;

  for (const row of rows) {
    const invoice = byId.get(row.invoice_id);
    if (!invoice) {
      // Invoice was deleted out from under the followup row — mark
      // abandoned to remove from the queue.
      await supabase
        .from('payment_followups')
        .update({ final_status: 'invoice_missing' })
        .eq('invoice_id', row.invoice_id);
      continue;
    }

    // If the bidder paid in the meantime, mark as 'paid' and stop dunning.
    if (invoice.status === 'paid') {
      await supabase
        .from('payment_followups')
        .update({ final_status: 'paid' })
        .eq('invoice_id', row.invoice_id);
      continue;
    }

    // If the invoice was canceled/refunded between attempts, mark done.
    if (invoice.status === 'canceled' || invoice.status === 'refunded') {
      await supabase
        .from('payment_followups')
        .update({ final_status: 'closed' })
        .eq('invoice_id', row.invoice_id);
      continue;
    }

    try {
      if (row.attempt_count >= 2) {
        // Bidder abandoned. Mark invoice + lots for relist + notify.
        await markAbandoned(supabase, invoice);
        abandoned++;
      } else {
        // Send 2nd reminder notification + schedule the abandon check.
        await sendReminder(supabase, invoice, row);
        reminded++;
      }
    } catch (err) {
      console.error('[payment-followups] error on', row.invoice_id, err);
      errors++;
    }
  }

  return { scanned: rows.length, reminded, abandoned, errors };
}

async function sendReminder(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  invoice: InvoiceForFollowup,
  row: FollowupRow,
): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + REMINDER_INTERVAL_MS);

  await supabase.from('notifications_outbox').insert({
    target_user_id: invoice.bidder_id,
    kind: 'payment_retry_reminder',
    idempotency_key: `payment_retry_reminder:${invoice.id}:${row.attempt_count + 1}`,
    payload: {
      invoice_id: invoice.id,
      // 2026-09-14: this was `retry_deep_link: clovrbid://…` — two defects that
      // cancelled out. No consumer reads `retry_deep_link` (they all read
      // `deep_link`), so the dead clovrbid:// scheme was ignored and the tap
      // fell through to _layout.tsx's kind dispatch, which routes
      // payment_retry_reminder to /invoice/[id] anyway. Fixing only the key
      // would have armed the broken scheme and BROKEN a working path, so both
      // move together.
      deep_link: bidderDeepLink(`invoice/${invoice.id}`),
      attempt: row.attempt_count + 1,
    },
  }).then(undefined, () => undefined); // unique-violation = already sent

  await supabase
    .from('payment_followups')
    .update({
      last_attempt_at: now.toISOString(),
      next_attempt_at: next.toISOString(),
      attempt_count: row.attempt_count + 1,
    })
    .eq('invoice_id', invoice.id);
}

async function markAbandoned(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  invoice: InvoiceForFollowup,
): Promise<void> {
  // 1. Flip invoice → unpaid_no_show.
  await supabase
    .from('invoices')
    .update({ status: 'unpaid_no_show' })
    .eq('id', invoice.id);

  // 2. Flip the lots the bidder still owes → relisted. invoice_lots joins
  // invoice→lot. A line the counter already stamped picked up is the
  // customer's item, not stock (2026-09-14 audit): it stays as it is and is
  // logged, instead of being reclaimed in the same statement as the rest.
  // 0358 skips such a row at the table anyway; filtering here keeps this
  // job's own record honest.
  const { data: lotLinks } = await supabase
    .from('invoice_lots')
    .select('lot_id, picked_up_at')
    .eq('invoice_id', invoice.id);
  const links = (lotLinks ?? []) as { lot_id: string; picked_up_at: string | null }[];
  const lotIds = links.filter((l) => l.picked_up_at === null).map((l) => l.lot_id);
  const collected = links.length - lotIds.length;
  if (collected > 0) {
    console.warn(
      `[payment-followups] invoice ${invoice.id}: ${collected} lot(s) already collected; left untouched`,
    );
  }
  if (lotIds.length > 0) {
    const { error: lotsErr } = await supabase
      .from('lots')
      .update({ status: 'relisted' })
      .in('id', lotIds);
    if (lotsErr) {
      console.error('[payment-followups] lot flip failed for', invoice.id, lotsErr.message);
    }
  }

  // 3. Notify bidder.
  await supabase.from('notifications_outbox').insert({
    target_user_id: invoice.bidder_id,
    kind: 'lot_relisted_no_show',
    idempotency_key: `lot_relisted_no_show:${invoice.id}`,
    payload: { invoice_id: invoice.id, lot_count: lotIds.length },
  }).then(undefined, () => undefined);

  // 4. Mark followup row as final.
  await supabase
    .from('payment_followups')
    .update({ final_status: 'abandoned' })
    .eq('invoice_id', invoice.id);
}
