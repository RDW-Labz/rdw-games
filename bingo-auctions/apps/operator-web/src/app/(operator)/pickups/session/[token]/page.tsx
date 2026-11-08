// Staff counter page for a pickup-session QR (mig 0241 Phase 1).
//
// The bidder's pass QR encodes /pickups/session/{token}; staff scan it with
// any phone camera and land here (operator layout enforces staff auth).
// Shows the customer, every invoice they can pick up (paid + unpaid), and
// every lot with its bin + the bidder's own collected checkmarks — then one
// button completes every PAID pickup at once. Unpaid invoices are listed
// with a "collect payment first" pointer; markPickup's paid-guard is the
// hard backstop either way.
//
// Deliberately NOT gated on pickup_sessions_enabled: an already-issued QR
// must always scan, even if the rollout flag gets flipped off mid-visit.

import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { PageHeader } from '@/components/Form';
import { DataTable, StatusPill, MoneyText, type Column } from '@/components/console';
import { loadSessionContents } from '@/lib/pickup-session';
import { CompleteSessionButton } from './CompleteSessionButton';
import { SessionItems } from './SessionItems';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PickupSessionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const admin = getSupabaseAdmin();

  const { data: sessionRow } = await admin
    .from('pickup_sessions')
    .select('id, bidder_id, status, collected_lot_ids, created_at, bidders(email, display_name, phone)')
    .eq('token', token)
    .maybeSingle();

  const session = sessionRow as unknown as {
    id: string;
    bidder_id: string;
    status: string;
    collected_lot_ids: string[];
    bidders: { email: string | null; display_name: string | null; phone: string | null } | null;
  } | null;

  if (!session) {
    return (
      <div>
        <PageHeader title="Pickup session" />
        <p style={{ color: 'var(--danger)', fontSize: 14 }}>
          No pickup session matches this code. Ask the customer to reopen their Pickup pass and
          scan again.
        </p>
      </div>
    );
  }

  const { invoices, items } = await loadSessionContents(session.bidder_id);
  const collected = new Set(session.collected_lot_ids ?? []);
  const paid = invoices.filter((i) => i.status === 'paid' || i.status === 'partially_refunded');
  const unpaid = invoices.filter((i) => i.status !== 'paid' && i.status !== 'partially_refunded');
  const bidderName = session.bidders?.display_name ?? session.bidders?.email ?? 'Customer';

  type InvoiceRow = (typeof invoices)[number];
  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: 'invoice',
      header: 'Invoice',
      cell: (inv) => (
        <Link href={`/invoices/${inv.id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
          {inv.id.slice(0, 8)}
        </Link>
      ),
    },
    { key: 'auction', header: 'Auction', cell: (inv) => inv.auctionTitle ?? '—' },
    { key: 'total', header: 'Total', numeric: true, cell: (inv) => <MoneyText cents={inv.totalCents} /> },
    { key: 'payment', header: 'Payment', cell: (inv) => <StatusPill status={inv.status} /> },
    { key: 'lots', header: 'Lots', numeric: true, cell: (inv) => inv.lotCount },
  ];

  return (
    <div>
      <PageHeader title={`Pickup — ${bidderName}`} />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem' }}>
        {session.bidders?.email}
        {session.bidders?.phone ? ` · ${session.bidders.phone}` : ''}
        {' · '}
        {items.length} item{items.length === 1 ? '' : 's'} across {invoices.length} invoice
        {invoices.length === 1 ? '' : 's'}
        {session.status !== 'open' && (
          <strong style={{ color: 'var(--accent)' }}> · session {session.status}</strong>
        )}
      </p>

      {invoices.length === 0 && (
        <p style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
          Nothing left to pick up on this account — every pickup is already completed or closed.
        </p>
      )}

      {unpaid.length > 0 && (
        <div
          style={{
            padding: '0.85rem 1rem',
            border: '1px solid rgba(234,179,8,0.4)',
            background: 'rgba(234,179,8,0.08)',
            borderRadius: 8,
            fontSize: 13,
            marginBottom: '1rem',
          }}
        >
          <strong>{unpaid.length} unpaid invoice{unpaid.length === 1 ? '' : 's'}</strong> — collect
          payment (or use the invoice&apos;s &quot;Mark paid&quot; action) before releasing those
          lots. Completing below only closes out the paid ones.
        </div>
      )}

      {/* Invoices table */}
      {invoices.length > 0 && (
        <div style={{ marginBottom: '1.25rem' }}>
          <DataTable columns={invoiceColumns} rows={invoices} rowKey={(inv) => inv.id} />
        </div>
      )}

      {/* Per-lot outcomes (mig 0243): Collected / Missing / Later. Missing
          items don't block checkout — they land in the refund queue on the
          pickups dashboard; Later keeps that invoice's pickup open. */}
      {items.length > 0 && (
        <SessionItems token={token} items={items} customerCollected={[...collected]} />
      )}

      {session.status === 'open' && paid.length > 0 && (
        <CompleteSessionButton token={token} paidCount={paid.length} />
      )}
    </div>
  );
}

