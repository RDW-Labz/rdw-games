// Dispute evidence-deadline reminder scanner (E2).
//
// Finds invoices with an open Stripe dispute whose evidence_due_by is within
// 48 hours (column added in mig 0167). Notifies each operator admin/manager
// user once per dispute (idempotency key dispute_evidence_due:{dispute_id}).
//
// The `dispute_evidence_due` notification_kind exists from mig 0077:183.
// The drain case is already live in notifications-drain.ts:158.
//
// Cadence: every 30 minutes (same bucket as payment-followups in
// apps/cron-trigger/src/index.ts). At 30-min cadence the earliest a
// reminder can miss is a dispute whose evidence_due_by falls inside one
// 30-min window — acceptable for a 48h lead time.

import { getSupabaseAdmin } from '@/lib/supabase-admin';

// Remind when the deadline is within this many hours.
const REMIND_WINDOW_HOURS = 48;

type DisputeInvoiceRow = {
  id: string;
  operator_id: string;
  dispute_id: string;
  evidence_due_by: string;
};

export type DisputeDeadlineRemindersResult = {
  scanned: number;
  enqueued: number;
};

export async function runDisputeDeadlineReminders(): Promise<DisputeDeadlineRemindersResult> {
  const supabase = getSupabaseAdmin();

  // Fetch invoices with an open dispute whose evidence deadline is coming up
  // within REMIND_WINDOW_HOURS AND that haven't been reminded yet.
  // "Not yet reminded" = no notifications_outbox row with idempotency key
  // dispute_evidence_due:{dispute_id}. We check existence via a NOT IN
  // subquery expressed as a second query (supabase-js doesn't support NOT
  // EXISTS filters directly).
  const windowEnd = new Date(
    Date.now() + REMIND_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { data: rows, error } = await supabase
    .from('invoices')
    .select('id, operator_id, dispute_id, evidence_due_by')
    .not('dispute_id', 'is', null)
    .not('evidence_due_by', 'is', null)
    .in('dispute_status', ['needs_response', 'warning_needs_response'])
    .lt('evidence_due_by', windowEnd)
    .gt('evidence_due_by', new Date().toISOString()) // not already past
    .returns<DisputeInvoiceRow[]>();

  if (error) {
    console.error('[dispute-deadline-reminders] query error:', error.message);
    return { scanned: 0, enqueued: 0 };
  }

  const candidates = rows ?? [];
  if (candidates.length === 0) {
    return { scanned: 0, enqueued: 0 };
  }

  // Determine which ones haven't been notified yet.
  const idempotencyKeys = candidates.map(
    (r) => `dispute_evidence_due:${r.dispute_id}`,
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
    (r) => !alreadySent.has(`dispute_evidence_due:${r.dispute_id}`),
  );

  let enqueued = 0;

  for (const invoice of toNotify) {
    // Notify all admin/manager staff for this operator.
    const { data: staff } = await supabase
      .from('operator_users')
      .select('user_id')
      .eq('operator_id', invoice.operator_id)
      .in('role', ['admin', 'manager']);

    for (const s of (staff ?? []) as Array<{ user_id: string }>) {
      const { error: insertErr } = await supabase
        .from('notifications_outbox')
        .insert({
          target_user_id: s.user_id,
          kind: 'dispute_evidence_due',
          idempotency_key: `dispute_evidence_due:${invoice.dispute_id}`,
          payload: {
            invoice_id: invoice.id,
            dispute_id: invoice.dispute_id,
            evidence_due_by: invoice.evidence_due_by,
          },
        });

      if (insertErr && insertErr.code !== '23505') {
        // 23505 = unique_violation (idempotency key conflict) — safe to ignore.
        console.warn(
          '[dispute-deadline-reminders] insert error for dispute',
          invoice.dispute_id,
          insertErr.message,
        );
      } else if (!insertErr) {
        enqueued++;
      }
    }
  }

  return { scanned: candidates.length, enqueued };
}
