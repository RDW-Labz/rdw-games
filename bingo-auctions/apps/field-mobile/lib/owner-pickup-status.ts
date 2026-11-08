// One line of "where is this sale" text for the iPad screens that show a
// lot's winning customer (Lot Lookup, Relot, the checkout wrong-customer
// alert), from staff_scan_lot_owner's owner object. Pure so it is tested.
//
// 2026-10-28 (TEA4842561): every screen fell back to "Awaiting pickup" when
// nothing else matched, so a declined-and-relisted sale (BIN-031301) read as
// an item waiting for its buyer. Never default to that: it is only true for
// a paid sale with nothing handed over, refunded or forfeited.

export type OwnerStatusInput = {
  invoice_status?: string | null;
  picked_up_at?: string | null;
  refunded_at?: string | null;
  pickup_status?: string | null;
  pickup_completed_at?: string | null;
};

const fmt = (iso: string) => new Date(iso).toLocaleDateString();
const PAID = new Set(['paid', 'partially_refunded', 'refunded']);

export function ownerPickupStatus(o: OwnerStatusInput): string {
  if (o.refunded_at) return `Refunded ${fmt(o.refunded_at)} — not handed over`;
  if (o.picked_up_at) return `Picked up ${fmt(o.picked_up_at)}`;
  if (o.invoice_status === 'payment_failed_relisted' || o.invoice_status === 'canceled') {
    return 'Relisted — sale cancelled';
  }
  if (!o.invoice_status || !PAID.has(o.invoice_status)) return 'Not paid — do not hand over';
  if (o.pickup_status === 'completed') {
    return o.pickup_completed_at ? `Picked up ${fmt(o.pickup_completed_at)}` : 'Picked up';
  }
  if (o.pickup_status && o.pickup_status !== 'pending' && o.pickup_status !== 'scheduled') {
    return o.pickup_status.replace(/_/g, ' ');
  }
  return 'Awaiting pickup';
}
