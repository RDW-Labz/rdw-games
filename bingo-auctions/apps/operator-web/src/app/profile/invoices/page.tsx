// /profile/invoices — bidder-facing invoice list (L0 launch blocker #5).
// S11 (2026-06-01): show "Update by {date}" chip on payment_failed_grace rows.
//
// Bidders WILL ask "where's my receipt?" on day one. The operator
// console has /(operator)/invoices/[id] but that's gated behind staff
// auth (operator_id = current_operator_id() RLS). Bidders need their
// own surface that uses the matching invoices_self_read RLS policy
// from migration 0002 (bidder_id = auth.uid()).
//
// Auth: middleware already gates /profile* (not in PUBLIC_ROUTE_PREFIXES
// — only /bidder/onboarding is whitelisted for the pre-onboarded user).
// Server component re-checks defensively.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { formatDateInTimeZone } from '@/lib/datetime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same palette the operator-facing /invoices page uses so bidders + ops
// share a color language for invoice status.
function statusColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'paid':
      return { bg: 'var(--success-dim)', fg: 'var(--success)' };
    case 'pending':
      return { bg: 'var(--warning-dim)', fg: 'var(--warning)' };
    case 'refunded':
    case 'partially_refunded':
      return { bg: 'var(--accent-dim)', fg: 'var(--accent)' };
    case 'unpaid_no_show':
    case 'payment_failed_grace':
    case 'payment_failed_relisted':
      return { bg: 'rgba(255, 59, 59, 0.12)', fg: 'var(--danger)' };
    case 'canceled':
    default:
      return { bg: 'var(--bg-elev)', fg: 'var(--fg-muted)' };
  }
}

interface InvoiceRow {
  id: string;
  status: string;
  total_cents: number;
  created_at: string;
  paid_at: string | null;
  grace_until: string | null;
  auction_id: string;
  operator_id: string;
  auctions: { title: string | null } | null;
  operators: { business_name: string | null } | null;
}

export default async function ProfileInvoicesPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/profile/invoices');
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect('/bidder/onboarding?next=/profile/invoices');
  }

  // RLS auto-restricts via invoices_self_read; explicit bidder_id filter
  // is belt-and-braces (matches the index on invoices_bidder_idx, so the
  // planner still chooses the cheap path).
  const { data: invoicesData } = await supabase
    .from('invoices')
    .select(
      'id, status, total_cents, created_at, paid_at, grace_until, auction_id, operator_id, auctions(title), operators:operators_public(business_name)',
    )
    .eq('bidder_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);

  const invoices = (invoicesData as unknown as InvoiceRow[] | null) ?? [];

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 900, margin: '0 auto' }}>
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

      <header style={{ marginBottom: '2.5rem' }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: 2,
            marginBottom: 4,
          }}
        >
          Account
        </div>
        <h1
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
            fontWeight: 900,
            letterSpacing: -1,
            margin: 0,
          }}
        >
          Your invoices
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          Receipts for every auction you&apos;ve won.
        </div>
      </header>

      {invoices.length === 0 ? (
        <section
          style={{
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '2rem 1.5rem',
            textAlign: 'center',
            color: 'var(--fg-muted)',
            fontSize: 14,
            lineHeight: 1.7,
          }}
        >
          <div style={{ marginBottom: '0.75rem' }}>
            No invoices yet &mdash; you&apos;ll see receipts here after you win your first auction.
          </div>
          <Link href="/browse" className="btn-primary" style={{ padding: '0.6rem 1.25rem' }}>
            Browse auctions
          </Link>
        </section>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {invoices.map((inv) => (
            <InvoiceCard key={inv.id} invoice={inv} />
          ))}
        </div>
      )}
    </main>
  );
}

function InvoiceCard({ invoice }: { invoice: InvoiceRow }) {
  const pill = statusColor(invoice.status);
  const operatorName = invoice.operators?.business_name ?? '—';
  const auctionTitle = invoice.auctions?.title ?? 'Auction';
  const dateRaw = invoice.status === 'paid' && invoice.paid_at ? invoice.paid_at : invoice.created_at;
  const dateLabel = invoice.status === 'paid' && invoice.paid_at ? 'Paid' : 'Created';

  // S11: grace deadline label shown on payment_failed_grace rows.
  // Server component on Cloudflare (UTC runtime) — format explicitly in
  // Central time or evening payments show tomorrow's date (owner report
  // 2026-07-08 'receipt dates are off from central time').
  const graceLabel = invoice.status === 'payment_failed_grace' && invoice.grace_until
    ? `Update by ${formatDateInTimeZone(invoice.grace_until, null)}`
    : null;

  return (
    <Link
      href={`/profile/invoices/${invoice.id}`}
      style={{
        display: 'block',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1rem 1.25rem',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              marginBottom: 4,
            }}
          >
            {operatorName}
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {auctionTitle}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                background: pill.bg,
                color: pill.fg,
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
              }}
            >
              {invoice.status}
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {dateLabel} {formatDateInTimeZone(dateRaw, null)}
            </span>
            {graceLabel && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--danger)',
                  background: 'rgba(255, 59, 59, 0.12)',
                  padding: '2px 8px',
                  borderRadius: 4,
                }}
              >
                {graceLabel}
              </span>
            )}
          </div>
        </div>
        <div
          style={{
            textAlign: 'right',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--fg)' }}>
            {formatCents(invoice.total_cents)}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--accent)',
              marginTop: 4,
              fontWeight: 600,
            }}
          >
            View receipt &rarr;
          </div>
        </div>
      </div>
    </Link>
  );
}
