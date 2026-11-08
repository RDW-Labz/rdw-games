// Append-only charge-attempt log + bidder card-fact capture (mig 0332).
//
// Why this exists: invoices.last_auto_charge_error is ONE column that every
// retry overwrites, and `mark-paid` stamps 'offline_paid_by_operator' over it.
// So when a customer (2026-08-25) reported they couldn't pay with a prepaid
// card, the ten declines behind that were unanswerable — each rescue at the
// counter had erased the issuer's reason. Every charge path now also appends a
// row here, which nothing rewrites.
//
// Both functions are best-effort by design: the money has already moved (or
// already failed) by the time they run, so a logging failure must never turn
// into a request failure. They log loudly and return.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentCardFacts } from '@/lib/square';

export type ChargeAttemptSource = 'auto_charge' | 'manual_retry' | 'offline_mark_paid';
export type ChargeAttemptOutcome = 'succeeded' | 'declined' | 'error' | 'settled_offline';

export type ChargeAttemptInput = {
  invoiceId: string;
  operatorId: string;
  bidderId?: string | null;
  source: ChargeAttemptSource;
  outcome: ChargeAttemptOutcome;
  amountCents?: number | null;
  cardId?: string | null;
  squareCode?: string | null;
  squareDetail?: string | null;
  squareStatus?: string | null;
  squarePaymentId?: string | null;
  cardFacts?: PaymentCardFacts | null;
  attemptNumber?: number | null;
};

type Admin = SupabaseClient<any, any, any>;

export async function recordChargeAttempt(admin: Admin, input: ChargeAttemptInput): Promise<void> {
  const { error } = await admin.from('charge_attempts').insert({
    invoice_id: input.invoiceId,
    operator_id: input.operatorId,
    bidder_id: input.bidderId ?? null,
    source: input.source,
    outcome: input.outcome,
    amount_cents: input.amountCents ?? null,
    card_id: input.cardId ?? null,
    // Truncated to keep a pathological Square `detail` from bloating the log.
    square_code: input.squareCode?.slice(0, 200) ?? null,
    square_detail: input.squareDetail?.slice(0, 1000) ?? null,
    square_status: input.squareStatus ?? null,
    square_payment_id: input.squarePaymentId ?? null,
    card_type: input.cardFacts?.cardType ?? null,
    prepaid_type: input.cardFacts?.prepaidType ?? null,
    attempt_number: input.attemptNumber ?? null,
  });
  if (error) console.error('[charge-attempts] insert failed', input.invoiceId, error.message);
}

/**
 * Store what Square reported about the card on a payment.
 *
 * Square returns card_type / prepaid_type only on Payments API responses, never
 * on CreateCard — so a bidder's card type is knowable only once a charge has
 * been attempted. A NULL prepaid_type on `bidders` therefore means "we have
 * never learned", which is different from UNKNOWN (Square looked and couldn't
 * say).
 */
export async function persistBidderCardFacts(
  admin: Admin,
  bidderId: string,
  facts: PaymentCardFacts | null | undefined,
): Promise<void> {
  if (!facts || (!facts.cardType && !facts.prepaidType)) return;
  const { error } = await admin
    .from('bidders')
    .update({
      card_type: facts.cardType,
      prepaid_type: facts.prepaidType,
      card_facts_synced_at: new Date().toISOString(),
    })
    .eq('id', bidderId);
  if (error) console.error('[charge-attempts] card facts update failed', bidderId, error.message);
}

/** Pull code + detail off an unknown thrown value without importing the error class. */
export function squareErrorParts(err: unknown): { code: string; detail: string | null } {
  const e = err as { errors?: Array<{ code?: string; detail?: string }>; message?: string };
  const first = Array.isArray(e?.errors) ? e.errors[0] : undefined;
  if (first?.code) return { code: first.code, detail: first.detail ?? null };
  return { code: e?.message ?? 'unknown_square_error', detail: null };
}
