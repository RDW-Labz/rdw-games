import { StatusPill } from '@/components/console-v2/StatusPill';

export function invoiceIsPaidForPickup(status: string | null): boolean {
  return status === 'paid' || status === 'partially_refunded';
}

export function InvoicePaymentPill({ status }: { status: string | null }) {
  if (status === 'partially_refunded') return <StatusPill status="partially_refunded" />;
  if (status === 'paid') return <StatusPill status="paid" />;
  if (status === 'refunded') return <StatusPill status="refunded" />;
  return <StatusPill status="unpaid" />;
}
