// Refund overrides (mig 0474) — every manager refund recorded outside Square
// (cash from the drawer or account credit), newest first, with who typed
// their name, why, and the caps in force. Admin/manager only. The table is
// server-only (no client grants), so it is read with the service role after
// the role check.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { formatCents } from '@auction-platform/shared/money';
import { DEFAULT_TIME_ZONE, formatDateInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { DataTable, KpiCard, MoneyText, MonoText, type Column } from '@/components/console';

export const dynamic = 'force-dynamic';

type Row = {
  id: number;
  invoice_id: string;
  lot_id: string;
  amount_cents: number;
  method: 'cash' | 'store_credit';
  staff_name: string;
  reason: string;
  cause: string | null;
  line_paid_cents: number;
  created_at: string;
  lots: { lot_code: string | null; sticker_code: string | null; title: string | null } | null;
};

export default async function RefundOverridesPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!me) redirect('/onboarding');
  const { operator_id: operatorId, role } = me as { operator_id: string; role: string };
  if (role !== 'admin' && role !== 'manager') {
    return (
      <div>
        <PageHeader title="Refund overrides" />
        <p style={{ color: 'var(--fg-muted)' }}>Admins or managers only.</p>
      </div>
    );
  }

  const admin = getSupabaseAdmin();
  const [{ data, error }, { data: caps }] = await Promise.all([
    admin
      .from('refund_overrides')
      .select('id, invoice_id, lot_id, amount_cents, method, staff_name, reason, cause, line_paid_cents, created_at, lots(lot_code, sticker_code, title)')
      .eq('operator_id', operatorId)
      .order('created_at', { ascending: false })
      .limit(2000),
    admin
      .from('refund_override_settings')
      .select('per_use_max_cents, daily_max_cents, updated_by_name, updated_at')
      .eq('operator_id', operatorId)
      .maybeSingle(),
  ]);
  const rows = (data ?? []) as unknown as Row[];
  const tz = DEFAULT_TIME_ZONE;
  const day = (iso: string) =>
    formatDateInTimeZone(iso, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = day(new Date().toISOString());
  const todayCents = rows
    .filter((r) => day(r.created_at) === today)
    .reduce((a, r) => a + r.amount_cents, 0);
  const capRow = caps as { per_use_max_cents: number; daily_max_cents: number } | null;
  const perUse = capRow?.per_use_max_cents ?? 2500;
  const daily = capRow?.daily_max_cents ?? 10000;

  const columns: Column<Row>[] = [
    { key: 'at', header: 'When', cell: (r) => formatDateInTimeZone(r.created_at, tz) },
    {
      key: 'lot',
      header: 'Item',
      cell: (r) => (
        <Link href={`/invoices/${r.invoice_id}`} style={{ fontFamily: 'var(--font-mono), monospace' }}>
          {r.lots?.sticker_code?.split(':').pop() ?? r.lots?.lot_code ?? r.lot_id.slice(0, 8)}
        </Link>
      ),
    },
    { key: 'title', header: 'Title', cell: (r) => r.lots?.title ?? '—' },
    { key: 'amount', header: 'Amount', numeric: true, cell: (r) => <MoneyText cents={r.amount_cents} /> },
    { key: 'paid', header: 'Item paid', numeric: true, cell: (r) => <MoneyText cents={r.line_paid_cents} /> },
    { key: 'method', header: 'How', cell: (r) => (r.method === 'cash' ? 'Cash' : 'Account credit') },
    { key: 'by', header: 'Name typed', cell: (r) => r.staff_name },
    { key: 'why', header: 'Why', cell: (r) => r.reason },
    { key: 'cause', header: 'Why Square could not', cell: (r) => <MonoText dim style={{ fontSize: 12 }}>{r.cause ?? '—'}</MonoText> },
  ];

  return (
    <div>
      <PageHeader title="Refund overrides" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 780 }}>
        Refunds a manager recorded outside Square, for invoices not paid by card. Cash came from the
        drawer; account credit went to the customer&apos;s balance. Limits: {formatCents(perUse)} per
        override, {formatCents(daily)} per day.
      </p>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <KpiCard label="Today" value={`${formatCents(todayCents)} of ${formatCents(daily)}`} />
        <KpiCard label="Overrides — all time" value={String(rows.length)} muted />
        <KpiCard label="Amount — all time" value={formatCents(rows.reduce((a, r) => a + r.amount_cents, 0))} muted />
      </section>
      {error && <p style={{ color: 'var(--danger)', fontSize: 14 }}>Couldn&apos;t load overrides: {error.message}</p>}
      <DataTable columns={columns} rows={rows} rowKey={(r) => String(r.id)} empty="No refund overrides yet." />
    </div>
  );
}
