// Manager refund override (mig 0474, 2026-10-27, Jared): for an invoice
// Square cannot refund because it was settled offline (cash/check at the
// counter, or marked paid by hand). Records a cash-from-drawer or
// store-credit refund. Pure module so it is unit-tested.
//
// The database function record_refund_override() is the gate: role, name,
// reason, line state, the line-paid limit, the cash limit and both caps are
// enforced there. The checks here only save a round trip and keep the copy in
// one place.

import { formatCents } from '@auction-platform/shared/money';

export type RefundOverrideMethod = 'cash' | 'store_credit';

export const REFUND_OVERRIDE_METHODS: { value: RefundOverrideMethod; label: string }[] = [
  { value: 'cash', label: 'Cash from the drawer' },
  { value: 'store_credit', label: 'Account credit' },
];

export const MIN_NAME_CHARS = 2;
export const MIN_REASON_CHARS = 5;

/**
 * Offered only on a paid invoice with no card payment: a card payment is
 * always refunded through Square (Refund), never around it.
 */
export function canOfferRefundOverride(inv: {
  status: string;
  square_payment_id: string | null;
  stripe_charge_id: string | null;
}): boolean {
  return (
    (inv.status === 'paid' || inv.status === 'partially_refunded') &&
    !inv.square_payment_id &&
    !inv.stripe_charge_id
  );
}

/**
 * Methods allowed for this invoice: credit-paid money only goes back as
 * credit, so cash is offered only when some of it was paid offline.
 */
export function allowedOverrideMethods(inv: {
  total_cents: number | null;
  credit_applied_cents: number | null;
  refunded_cash_cents: number | null;
}): RefundOverrideMethod[] {
  const cashLeft = (inv.total_cents ?? 0) - (inv.credit_applied_cents ?? 0) - (inv.refunded_cash_cents ?? 0);
  return cashLeft > 0 ? ['cash', 'store_credit'] : ['store_credit'];
}

/** Dollars typed by staff → cents; null when it is not a positive amount. */
export function parseDollarsToCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

export function refundOverrideInputError(input: {
  lotId: string | null;
  amountCents: number | null;
  lineMaxCents: number | null;
  method: RefundOverrideMethod | '';
  staffName: string;
  reason: string;
}): string | null {
  if (!input.lotId) return 'Pick the item.';
  if (input.amountCents == null) return 'Type the amount, e.g. 2.52.';
  if (input.lineMaxCents != null && input.amountCents > input.lineMaxCents) {
    return `That is more than this item was paid (${formatCents(input.lineMaxCents)}).`;
  }
  if (input.method !== 'cash' && input.method !== 'store_credit') return 'Pick how it goes back: cash or account credit.';
  if (input.staffName.trim().length < MIN_NAME_CHARS) return 'Type your name — the console login is shared.';
  if (input.reason.trim().length < MIN_REASON_CHARS) return 'Say why the customer is being refunded.';
  return null;
}

export type RefundOverrideResult = {
  ok: boolean;
  reason?: string;
  amount_cents?: number;
  method?: RefundOverrideMethod;
  line_paid_cents?: number;
  remaining_cents?: number;
  cash_left_cents?: number;
  cap_cents?: number;
  used_today_cents?: number;
  daily_cap_cents?: number;
  status?: string;
};

/** Plain words for every refusal from record_refund_override(). */
export function refundOverrideErrorMessage(r: RefundOverrideResult | null | undefined): string {
  switch (r?.reason) {
    case 'not_authenticated':
      return 'Sign in again — your session expired.';
    case 'manager_only':
      return 'Only managers and admins can use Refund override.';
    case 'staff_name_required':
      return 'Type your name — the console login is shared.';
    case 'reason_required':
      return 'Say why the customer is being refunded.';
    case 'bad_method':
      return 'Pick how it goes back: cash or account credit.';
    case 'bad_amount':
      return 'Type an amount above $0.00.';
    case 'not_found':
    case 'lot_not_in_invoice':
      return 'That item is not on this invoice.';
    case 'invoice_already_refunded':
      return 'This invoice is already fully refunded.';
    case 'not_paid':
      return `This invoice is ${r.status ?? 'not paid'}, so there is nothing to refund.`;
    case 'use_card_refund':
      return 'This invoice was paid by card. Use Refund — card money goes back through Square only.';
    case 'lot_already_refunded':
      return 'That item was already refunded.';
    case 'lot_forfeited':
      return 'That item was forfeited by a no-show. Undo the forfeit first if that was a mistake.';
    case 'over_line_paid':
      return `That is more than this item was paid (${formatCents(Math.min(r.line_paid_cents ?? 0, r.remaining_cents ?? r.line_paid_cents ?? 0))}).`;
    case 'cash_over_paid_offline':
      return r.cash_left_cents
        ? `Only ${formatCents(r.cash_left_cents)} was paid in cash. Give the rest as account credit.`
        : 'This item was paid with account credit, so it can only go back as account credit.';
    case 'over_per_use_cap':
      return `Over the ${formatCents(r.cap_cents ?? 0)} limit for one override. An admin must handle it.`;
    case 'over_daily_cap':
      return `Today's override limit is ${formatCents(r.cap_cents ?? 0)} and ${formatCents(r.used_today_cents ?? 0)} is used. An admin must handle it.`;
    default:
      return `Refund override failed${r?.reason ? `: ${r.reason}` : ''}. Nothing was changed.`;
  }
}

export function refundOverrideDoneMessage(r: RefundOverrideResult, lotCode: string | null): string {
  const how = r.method === 'cash' ? 'in cash — hand it from the drawer' : 'as account credit';
  return `Recorded: ${formatCents(r.amount_cents ?? 0)} back ${how}${lotCode ? ` for ${lotCode}` : ''}.`;
}
