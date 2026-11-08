// Settlements view for the operator: the ledger of marketplace charges and the
// platform fee taken on each.
//
// Money model: charges are Stripe Connect DESTINATION charges, so each invoice's
// operator share is transferred to the operator's connected account at PAYMENT
// time — BinGo Auctions does not hold a platform balance on their behalf. Rows are
// therefore "Transferred"; Stripe controls downstream payouts to the operator's
// bank. The legacy "Held"/"Releasable" states only exist for pre-destination-
// charge ledger rows and are no longer produced (no release_at is ever set),
// which is why the operators.settlement_hold_days setting was removed.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import {
  KpiCard,
  DataTable,
  StatusPill,
  MoneyText,
  MonoText,
  type Column,
} from '@/components/console';

type SettlementRow = {
  id: string;
  amount_cents: number;
  application_fee_cents: number;
  refund_cents: number;
  status: 'held' | 'releasable' | 'transferred' | 'voided';
  release_at: string;
  transferred_at: string | null;
  last_error: string | null;
  invoice_id: string;
  invoices:
    | {
        total_cents: number;
        paid_at: string | null;
        bidders: { email?: string; display_name?: string | null } | null;
      }
    | null;
};

export default async function SettlementsPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: rows } = await supabase
    .from('operator_settlements')
    .select(
      'id, amount_cents, application_fee_cents, refund_cents, status, release_at, transferred_at, last_error, invoice_id, invoices(total_cents, paid_at, bidders(email, display_name))',
    )
    .order('release_at', { ascending: false })
    .limit(200);

  const all = (rows ?? []) as unknown as SettlementRow[];

  const heldTotal = all
    .filter((r) => r.status === 'held')
    .reduce((s, r) => s + r.amount_cents, 0);
  const releasableTotal = all
    .filter((r) => r.status === 'releasable')
    .reduce((s, r) => s + r.amount_cents, 0);
  const transferredTotal = all
    .filter((r) => r.status === 'transferred')
    .reduce((s, r) => s + r.amount_cents, 0);
  const platformFeeTotal = all.reduce((s, r) => s + r.application_fee_cents, 0);

  const columns: Column<SettlementRow>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <div>
          <StatusPill status={r.status} />
          {r.last_error && (
            <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{r.last_error}</div>
          )}
        </div>
      ),
    },
    {
      key: 'bidder',
      header: 'Bidder',
      cell: (r) => r.invoices?.bidders?.display_name ?? r.invoices?.bidders?.email ?? '—',
    },
    {
      key: 'total',
      header: 'Invoice total',
      numeric: true,
      cell: (r) =>
        r.invoices?.total_cents != null ? <MoneyText cents={r.invoices.total_cents} /> : '—',
    },
    {
      key: 'share',
      header: 'Your share',
      numeric: true,
      cell: (r) => <MoneyText cents={r.amount_cents} />,
    },
    {
      key: 'fee',
      header: 'Platform fee',
      numeric: true,
      cell: (r) => <MoneyText cents={r.application_fee_cents} style={{ color: 'var(--fg-muted)' }} />,
    },
    {
      key: 'refunds',
      header: 'Refunds',
      numeric: true,
      cell: (r) => (r.refund_cents > 0 ? <MoneyText cents={r.refund_cents} tone="owed" /> : '—'),
    },
    {
      key: 'when',
      header: 'Release / paid',
      cell: (r) => (
        // TODO(tz): transferred_at / release_at are Stripe Connect ledger events
        // at the operator-org level. operator_settlements has no warehouse; the
        // nearest one is a 2-hop embed (invoice → auction → warehouse). Left in
        // the SSR runtime zone for now — revisit if a settlements-by-warehouse
        // view is added.
        <MonoText dim style={{ fontSize: 13 }}>
          {r.transferred_at
            ? `Paid ${new Date(r.transferred_at).toLocaleString()}`
            : `Releases ${new Date(r.release_at).toLocaleString()}`}
        </MonoText>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Settlements" />

      <p style={{ color: 'var(--fg-muted)', maxWidth: 640, lineHeight: 1.6, marginTop: 0 }}>
        Bidders pay BinGo Auctions directly. Each charge is a Square payment on the BinGo
        Auctions Square account, and the platform fee is accounted for automatically. Square
        runs payouts to the linked bank on its normal schedule.
      </p>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <KpiCard label="Held (in window)" value={<MoneyText cents={heldTotal} />} />
        <KpiCard
          label="Releasable now"
          value={<MoneyText cents={releasableTotal} />}
          tone={releasableTotal > 0 ? 'accent' : 'default'}
        />
        <KpiCard label="Transferred to processor" value={<MoneyText cents={transferredTotal} />} muted />
        <KpiCard label="Platform fee paid" value={<MoneyText cents={platformFeeTotal} />} muted />
      </section>

      <h2 style={{ fontSize: '1.05rem' }}>Recent settlements</h2>
      <DataTable
        columns={columns}
        rows={all}
        rowKey={(r) => r.id}
        empty="No paid invoices yet."
      />
    </div>
  );
}
