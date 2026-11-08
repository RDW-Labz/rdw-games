// Plain words for the checkout refund sheet (2026-10-27, TEA3828564: staff
// saw only "Refund failed - no_payment_to_refund"). The server sends a code;
// staff need the cause and what to do next. Pure module so it is unit-tested.

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export type RefundResponseBody = {
  error?: string;
  lot_code?: string | null;
  remaining_cents?: number;
  cash_cents?: number;
  credit_cents?: number;
};

export function refundFailureMessage(body: RefundResponseBody, status: number): string {
  const code = body.error ?? '';
  switch (code) {
    case 'no_card_payment':
    case 'no_payment_to_refund':
      return 'This invoice was paid in cash or marked paid by hand, not by card, so Square can’t refund it. Ask a manager to use Refund override on the invoice in the console (cash from the drawer or account credit).';
    case 'lot_already_refunded':
      return `${body.lot_code ?? 'That item'} was already refunded.`;
    case 'lot_forfeited':
      return `${body.lot_code ?? 'That item'} was forfeited by a no-show, so it can’t be refunded here. A manager can undo the forfeit in the console if that was a mistake.`;
    case 'refund_exceeds_invoice_total':
      return typeof body.remaining_cents === 'number'
        ? `Only ${dollars(body.remaining_cents)} is left to refund on this invoice.`
        : 'That is more than is left to refund on this invoice.';
    case 'nothing_left_to_refund':
      return 'Nothing is left to refund on this invoice.';
    case 'refund_in_flight':
      return 'That refund is already going through. Wait a minute before trying again.';
    case 'lot_not_in_invoice':
      return 'That item is not on this invoice.';
    case 'forbidden':
    case 'not_authenticated':
      return 'Your login can’t refund. Ask a lead, manager or admin.';
    case 'refund_failed':
      return 'The refund did not go through and no money moved. Try again; if it fails again, tell a manager.';
    case '':
      return `Server returned ${status}. Try again or tell a manager.`;
    default:
      // Window, status and Square's own detail already arrive as sentences.
      return code;
  }
}

export function refundSuccessMessage(items: number, body: RefundResponseBody): string {
  const cash = body.cash_cents ?? 0;
  const credit = body.credit_cents ?? 0;
  const what = `${items} item${items === 1 ? '' : 's'}`;
  if (cash > 0 && credit > 0) {
    return `Refund for ${what}: ${dollars(cash)} back to the card through Square and ${dollars(credit)} back as account credit.`;
  }
  if (credit > 0) {
    return `Refund for ${what}: ${dollars(credit)} back as account credit (it was paid with credit). Nothing goes to a card.`;
  }
  return `Refund submitted to Square for ${what}. The card is credited once Square processes it.`;
}
