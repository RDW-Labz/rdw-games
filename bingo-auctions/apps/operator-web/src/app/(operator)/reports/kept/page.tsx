// Kept items — lots the business kept instead of auctioning (mig 0381), newest
// first. Each was recorded at a staff-entered price (0 allowed). These are NOT
// sales: no invoice, no charge, and every revenue figure (invoice-based) leaves
// them out. Admin/manager only; data + gate shared with the CSV export.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import {
  DEFAULT_TIME_ZONE,
  formatDateInTimeZone,
  monthRangeInTimeZone,
} from '@/lib/datetime';
import { summarizeKeeps, type KeptRow } from '@/lib/keep-for-business';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { DataTable, KpiCard, MoneyText, MonoText, type Column } from '@/components/console';
import { loadKeptReport } from './data';

export const dynamic = 'force-dynamic';

export default async function KeptItemsPage() {
  const supabase = await getSupabaseServer();
  const report = await loadKeptReport(supabase);
  if (!report.ok && report.status === 'no_user') redirect('/login');
  if (!report.ok && report.status === 'no_operator') redirect('/onboarding');
  if (!report.ok && report.status === 'forbidden') {
    return (
      <div>
        <PageHeader title="Kept items" />
        <p style={{ color: 'var(--fg-muted)' }}>Admins or managers only.</p>
      </div>
    );
  }

  // "This month" follows the warehouse wall clock, like the monthly P&L.
  const operatorId = report.ok ? report.operatorId : null;
  const { data: whRow } = operatorId
    ? await supabase
        .from('warehouses')
        .select('timezone')
        .eq('operator_id', operatorId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const tz = (whRow as { timezone: string } | null)?.timezone ?? DEFAULT_TIME_ZONE;
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const year = Number(nowParts.find((p) => p.type === 'year')?.value);
  const month = Number(nowParts.find((p) => p.type === 'month')?.value);
  const { startISO } = monthRangeInTimeZone(year, month, tz);

  const rows = report.ok ? report.rows : [];
  const names = report.ok ? report.staffNames : new Map<string, string>();
  const totals = summarizeKeeps(rows, startISO);

  const columns: Column<KeptRow>[] = [
    {
      key: 'lot',
      header: 'Lot',
      cell: (r) => (
        <Link href={`/lots/${r.lot_id}`} style={{ fontFamily: 'var(--font-mono), monospace' }}>
          {r.lot_code ?? r.lot_id.slice(0, 8)}
        </Link>
      ),
    },
    { key: 'title', header: 'Title', cell: (r) => r.title ?? '—' },
    { key: 'price', header: 'Price', numeric: true, cell: (r) => <MoneyText cents={r.kept_price_cents} /> },
    { key: 'reason', header: 'Reason', cell: (r) => r.reason },
    {
      key: 'by',
      header: 'Kept by',
      cell: (r) =>
        names.get(r.kept_by) ?? <MonoText dim style={{ fontSize: 12 }}>{r.kept_by.slice(0, 8)}</MonoText>,
    },
    { key: 'at', header: 'Kept', cell: (r) => formatDateInTimeZone(r.kept_at, tz) },
    { key: 'prior', header: 'Was', cell: (r) => r.prior_status.replace(/_/g, ' ') },
  ];

  return (
    <div>
      <PageHeader
        title="Kept items"
        action={
          <a href="/reports/kept/export" style={secondaryButtonStyle}>
            Download CSV
          </a>
        }
      />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 780 }}>
        Items the business kept instead of auctioning, at the price staff recorded when keeping
        them. <strong>These are not sales</strong> — there is no invoice or charge, and they are
        not in any revenue figure on the other reports.
      </p>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <KpiCard label="Kept — this month" value={String(totals.monthCount)} />
        <KpiCard label="Recorded price — this month" value={formatCents(totals.monthTotalCents)} />
        <KpiCard label="Kept — all time" value={String(totals.count)} muted />
        <KpiCard label="Recorded price — all time" value={formatCents(totals.totalCents)} muted />
      </section>

      {!report.ok && report.status === 'error' && (
        <div
          style={{
            padding: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Couldn&apos;t load kept items: {report.message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.lot_id}
        empty="Nothing has been kept for the business yet."
      />
    </div>
  );
}
