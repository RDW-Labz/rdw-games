// Operator shipping queue — list of paid invoices the operator owes a
// shipment for. Two stages:
//
//   1. Paid, no label yet  →  "Buy label" button
//   2. Label bought, not yet shipped  →  "Download label" + "Mark shipped"
//
// Already-shipped invoices fall off the queue (visible via a separate
// "Recently shipped" toggle).

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { ShippingQueue, type ShipRow } from './ShippingQueue';

export default async function ShippingPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show } = await searchParams;
  const showHistory = show === 'history';

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const operatorId = (me as { operator_id: string }).operator_id;

  // Active queue OR recently-shipped depending on toggle. We pull the
  // bidder display_name + shipping address so the operator doesn't have
  // to drill into each invoice to see who/where.
  let query = supabase
    .from('invoices')
    .select(
      'id, total_cents, shipping_cents, shipping_address, shipping_carrier, shipping_tracking_number, shipping_label_url, shipping_label_purchased_at, shipped_at, paid_at, bidders(display_name, email), invoice_lots(lot_id, lots(title))',
    )
    .eq('operator_id', operatorId)
    .eq('status', 'paid')
    .eq('fulfillment_method', 'ship')
    .order('paid_at', { ascending: false });

  if (!showHistory) {
    query = query.is('shipped_at', null);
  } else {
    query = query.not('shipped_at', 'is', null).limit(50);
  }

  const { data: rows } = await query;

  const shipRows: ShipRow[] = ((rows ?? []) as unknown as Array<{
    id: string;
    total_cents: number;
    shipping_cents: number;
    shipping_address: ShipRow['shippingAddress'] | null;
    shipping_carrier: string | null;
    shipping_tracking_number: string | null;
    shipping_label_url: string | null;
    shipping_label_purchased_at: string | null;
    shipped_at: string | null;
    paid_at: string | null;
    bidders: { display_name: string | null; email: string } | null;
    invoice_lots: Array<{ lot_id: string; lots: { title: string } | null }>;
  }>).map((r) => ({
    id: r.id,
    totalCents: r.total_cents,
    shippingCents: r.shipping_cents,
    shippingAddress: r.shipping_address,
    carrier: r.shipping_carrier,
    trackingNumber: r.shipping_tracking_number,
    labelOnFile: !!r.shipping_label_url,
    labelPurchasedAt: r.shipping_label_purchased_at,
    shippedAt: r.shipped_at,
    paidAt: r.paid_at,
    bidderName: r.bidders?.display_name ?? r.bidders?.email ?? 'Bidder',
    lotCount: r.invoice_lots.length,
    lotTitle: r.invoice_lots[0]?.lots?.title ?? null,
  }));

  return (
    <div>
      <PageHeader title="Shipping queue" />
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        Paid invoices waiting for a label or for you to hand off to the carrier.{' '}
        {showHistory ? (
          <a href="/shipping" style={{ color: 'var(--accent, #4f8cff)' }}>
            ← Back to active queue
          </a>
        ) : (
          <a href="/shipping?show=history" style={{ color: 'var(--accent, #4f8cff)' }}>
            View recently shipped →
          </a>
        )}
      </p>
      <ShippingQueue rows={shipRows} historical={showHistory} />
    </div>
  );
}
