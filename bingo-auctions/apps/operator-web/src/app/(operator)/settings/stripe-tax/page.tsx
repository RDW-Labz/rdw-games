// Sales tax acknowledgement page.
//
// (Route path kept as /settings/stripe-tax from the upstream fork so existing
// dashboard-checklist links keep working; everything user-facing says
// "Sales tax".)
//
// The operator is the legal merchant of record for sales tax. Two paths:
//
//   1. Flat-rate collection (mig 0214) — the platform adds the operator's
//      configured flat rate (operators.tax_rate_bps, gated on
//      operators.collect_sales_tax) to every invoice at build time, on
//      subtotal + buyer's premium. The operator remits what was collected.
//   2. Handle sales tax entirely themselves (charge nothing at checkout,
//      price it in, file returns on gross).
//
// Either way the operator clicks "I've handled this" to dismiss the
// checklist item — the acknowledgement is the operator's word for the
// checklist UX, not a verified tax registration.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { acknowledgeStripeTax } from '../../dashboard/actions';
import { PageHeader } from '@/components/Form';

export default async function SalesTaxSettingsPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: staff } = await supabase
    .from('operator_users')
    .select(
      'role, operators(id, business_name, stripe_onboarding_complete, stripe_tax_acknowledged_at, collect_sales_tax, tax_rate_bps)',
    )
    .eq('user_id', user.id)
    .single();

  const typed = staff as unknown as {
    role?: string;
    operators?: {
      id: string;
      business_name?: string;
      stripe_onboarding_complete?: boolean;
      stripe_tax_acknowledged_at?: string | null;
      collect_sales_tax?: boolean | null;
      tax_rate_bps?: number | null;
    };
  } | null;
  const op = typed?.operators;
  const isAdmin = typed?.role === 'admin';

  if (!op) redirect('/dashboard');
  if (!op.stripe_onboarding_complete) redirect('/onboarding');

  // Warehouse-origin tax model (Fix B): for in-person pickup the taxable
  // location is the WAREHOUSE, so the operator registers in their warehouse
  // state(s) — NOT "every state a bidder lives in". Name the state(s) so an
  // out-of-state operator knows exactly where to register. RLS scopes this to
  // the caller's operator; an empty result just drops the concrete naming.
  const { data: warehouseRows } = await supabase
    .from('warehouses')
    .select('state')
    .eq('operator_id', op.id);
  const warehouseStates = Array.from(
    new Set(
      ((warehouseRows ?? []) as Array<{ state: string | null }>)
        .map((w) => w.state)
        .filter((s): s is string => Boolean(s)),
    ),
  );
  const statesPhrase = warehouseStates.length > 0 ? warehouseStates.join(', ') : null;

  const acknowledged = op.stripe_tax_acknowledged_at != null;
  const flatTaxOn = op.collect_sales_tax === true;
  const flatTaxPct =
    op.tax_rate_bps != null ? (op.tax_rate_bps / 100).toFixed(op.tax_rate_bps % 100 === 0 ? 0 : 2) : null;

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title="Sales tax" />

      <p style={{ marginBottom: '1rem', lineHeight: 1.6, color: 'var(--fg-muted)' }}>
        Because <strong>{op.business_name ?? 'your auction house'}</strong> is the
        merchant of record on every bidder transaction, you are responsible for
        collecting and remitting sales tax on your sales.
      </p>

      <p style={{ marginBottom: '1.5rem', lineHeight: 1.6, color: 'var(--fg-muted)' }}>
        Because winning bidders collect their lots <strong>in person at your
        warehouse</strong>, sales tax on these transactions is based on your
        warehouse's location — not where each bidder lives.
        {statesPhrase
          ? ` Register and remit in the state(s) where your warehouse operates — currently ${statesPhrase}.`
          : ' Register and remit in the state(s) where your warehouse operates.'}
        {' '}BinGo Auctions doesn't provide tax advice; confirm your registrations with a
        tax professional.
      </p>

      <p style={{ marginBottom: '1.5rem', lineHeight: 1.6, color: 'var(--fg-muted)' }}>
        You have two clean ways to handle this:
      </p>

      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '1.25rem',
          marginBottom: '1rem',
          background: 'var(--bg-elevated)',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>
          Option 1 — Flat-rate collection at checkout (recommended)
        </h2>
        <p style={{ lineHeight: 1.6, color: 'var(--fg-muted)', fontSize: '0.95rem' }}>
          BinGo Auctions adds your configured flat rate to every invoice at
          checkout (applied to the winning bid plus buyer's premium). The tax
          collected is included in your settlement — you remit it with your
          normal filing.
        </p>
        <p style={{ lineHeight: 1.6, fontSize: '0.95rem' }}>
          {flatTaxOn ? (
            <strong style={{ color: 'var(--success, #4ade80)' }}>
              ✓ Enabled{flatTaxPct ? ` at ${flatTaxPct}%` : ''} for your account.
            </strong>
          ) : (
            <strong style={{ color: 'orange' }}>
              Not currently enabled for your account — contact platform support to
              turn it on with your rate.
            </strong>
          )}
        </p>
      </section>

      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '1.25rem',
          marginBottom: '1.5rem',
          background: 'var(--bg-elevated)',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>
          Option 2 — I handle this myself
        </h2>
        <p style={{ lineHeight: 1.6, color: 'var(--fg-muted)', fontSize: '0.95rem' }}>
          If you already have sales-tax registrations and a filing process and
          prefer tax-inclusive pricing, leave checkout collection off and file
          on your gross receipts yourself.
        </p>
      </section>

      {isAdmin ? (
        <form action={acknowledgeStripeTax}>
          <button
            type="submit"
            disabled={acknowledged}
            style={{
              background: acknowledged ? '#3a3' : 'var(--accent)',
              color: 'white',
              border: 'none',
              padding: '0.7rem 1.4rem',
              borderRadius: 6,
              cursor: acknowledged ? 'default' : 'pointer',
              fontSize: '0.95rem',
              fontWeight: 500,
            }}
          >
            {acknowledged
              ? `✓ Acknowledged ${new Date(op.stripe_tax_acknowledged_at!).toLocaleDateString()}`
              : "I've handled this — mark complete"}
          </button>
        </form>
      ) : (
        <p style={{ color: 'var(--fg-muted)', fontSize: '0.85rem' }}>
          Only an operator admin can mark this acknowledged.
        </p>
      )}

      <p style={{ marginTop: '2rem' }}>
        <Link href="/dashboard">← Back to dashboard</Link>
      </p>
    </div>
  );
}
