// /profile/pay-fees — clear outstanding bidder fees.
//
// Web equivalent of apps/bidder-app/app/profile/pay-fees.tsx. The 0105
// auto-charge policy adds a $5 relot fee whenever an auto-charge fails
// past the 48h grace window. Bidders can't place new bids while
// bidders.unpaid_fees_cents > 0; this page is the only path to settle.
//
// Server component renders the ledger snapshot; the PayFeesForm client
// component fires the existing POST /api/bidders/me/pay-fees endpoint.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PayFeesForm } from './PayFeesForm';
import { formatDateInTimeZone } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FeeRow = {
  id: string;
  amount_cents: number;
  reason: string;
  created_at: string;
  invoice_id: string | null;
  invoices: {
    invoice_lots: Array<{ lots: { lot_code: string | null } | null }>;
  } | null;
};

function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function PayFeesPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login?next=/profile/pay-fees');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id, unpaid_fees_cents, default_payment_method_id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/pay-fees');
  }

  const unpaidCents = (bidderRow.unpaid_fees_cents as number | null) ?? 0;
  const hasCard = !!bidderRow.default_payment_method_id;

  // No outstanding balance — show a confirmation panel instead of the
  // ledger so the bidder doesn't think this page is broken.
  if (unpaidCents <= 0) {
    return (
      <main style={{ padding: '4rem 1.5rem 5rem', maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>&#10004;</div>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 900, margin: '0 0 0.75rem' }}>
          You&apos;re all clear.
        </h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 15, lineHeight: 1.6, marginBottom: '2rem' }}>
          No outstanding fees on your account. Happy bidding.
        </p>
        <Link href="/profile" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}>
          Back to profile
        </Link>
      </main>
    );
  }

  // Load the unpaid ledger rows for itemized display.
  const { data: ledgerData } = await supabase
    .from('bidder_fee_ledger')
    .select(
      `id, amount_cents, reason, created_at, invoice_id,
       invoices(invoice_lots(lots(lot_code)))`,
    )
    .eq('bidder_id', user.id)
    .is('paid_at', null)
    .order('created_at', { ascending: false });

  const ledger = (ledgerData as unknown as FeeRow[] | null) ?? [];

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 560, margin: '0 auto' }}>
      <Link
        href="/profile"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '2rem',
        }}
      >
        &larr; Back to profile
      </Link>

      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 6,
        }}
      >
        Fees due
      </div>
      <h1
        style={{
          fontSize: 'clamp(2rem, 5vw, 3rem)',
          fontWeight: 900,
          color: 'var(--danger)',
          letterSpacing: -1,
          margin: '0 0 0.5rem',
        }}
      >
        {formatMoney(unpaidCents)}
      </h1>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: 14,
          lineHeight: 1.65,
          margin: '0 0 1.5rem',
        }}
      >
        You can&apos;t place new bids until this is paid. We&apos;ll charge the card on file.
      </p>

      {ledger.length > 0 && (
        <div
          style={{
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
            marginBottom: '1.5rem',
          }}
        >
          {ledger.map((row, idx) => {
            const lotCode = row.invoices?.invoice_lots?.[0]?.lots?.lot_code ?? null;
            const label =
              row.reason === 'relot_fee'
                ? lotCode
                  ? `Relot fee on lot ${lotCode}`
                  : 'Relot fee'
                : row.reason;
            return (
              <div
                key={row.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.85rem 1rem',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <div style={{ flex: 1, paddingRight: 12 }}>
                  <div style={{ fontSize: 14 }}>{label}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                    {formatDateInTimeZone(row.created_at, null)}
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  {formatMoney(row.amount_cents)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PayFeesForm hasCard={hasCard} unpaidCents={unpaidCents} />
    </main>
  );
}
