// Missing Items (mig 0426) — every item still marked missing, with the three
// ways to resolve it and who checked it when. Jared 2026-10-15.
//
// "Missing" is exactly what the 0345 relist guard enforces (latest pickup
// 'missing' outcome with no put-away since) plus 'missing' removals, computed
// in missing_items_report(). Unresolved items stay until somebody works them.
// ?all=1 also shows resolved items. Print and CSV cover the same rows.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { DEFAULT_TIME_ZONE, formatDateInTimeZone } from '@/lib/datetime';
import {
  OUTCOME_LABEL,
  STATE_LABEL,
  loadMissingReport,
  reasonText,
  type MissingCheck,
  type MissingRow,
} from '@/lib/missing-items-report';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { DataTable, KpiCard, type Column } from '@/components/console';
import { MissingRowActions } from './MissingRowActions';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';

export default async function MissingItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const all = (await searchParams).all === '1';
  const supabase = await getSupabaseServer();
  const report = await loadMissingReport(supabase, all);
  if (!report.ok && report.status === 'no_user') redirect('/login');
  if (!report.ok && report.status === 'no_operator') redirect('/onboarding');

  const rows = report.ok ? report.rows : [];
  const canManage = report.ok && (report.role === 'admin' || report.role === 'manager');

  // Verification history for the rows shown. RLS limits it to this operator.
  const history = new Map<string, MissingCheck[]>();
  const names = new Map<string, string>();
  const ids = rows.filter((r) => r.check_count > 0).map((r) => r.lot_id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from('missing_item_checks')
      .select('id, lot_id, outcome, note, removal_kind, checked_by, checked_at')
      .in('lot_id', ids.slice(i, i + 100))
      .order('checked_at', { ascending: false });
    for (const c of (data ?? []) as MissingCheck[]) {
      const list = history.get(c.lot_id) ?? [];
      list.push(c);
      history.set(c.lot_id, list);
    }
  }
  const byIds = [...new Set([...history.values()].flat().map((c) => c.checked_by).filter(Boolean))] as string[];
  if (byIds.length > 0) {
    const { data: staff } = await supabase
      .from('operator_users')
      .select('user_id, display_name, email')
      .in('user_id', byIds);
    for (const s of (staff ?? []) as Array<{ user_id: string; display_name: string | null; email: string }>) {
      names.set(s.user_id, s.display_name ?? s.email);
    }
  }

  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? DEFAULT_TIME_ZONE;
  const day = (iso: string | null) => (iso ? formatDateInTimeZone(iso, tz) : '—');

  const openCount = rows.filter((r) => r.state === 'open').length;
  const unsellableCount = rows.filter((r) => r.state === 'unsellable').length;

  const columns: Column<MissingRow>[] = [
    {
      key: 'photo',
      header: '',
      cell: (r) =>
        r.photo_url ? (
          <img
            src={r.photo_url}
            alt=""
            width={56}
            height={56}
            style={{ objectFit: 'cover', borderRadius: 6, display: 'block' }}
          />
        ) : (
          <div style={{ width: 56, height: 56, borderRadius: 6, background: 'var(--surface-2, #222)' }} />
        ),
    },
    {
      key: 'lot',
      header: 'Lot',
      cell: (r) => (
        <div style={{ display: 'grid', gap: 2 }}>
          <Link href={`/lots/${r.lot_id}`} style={{ fontFamily: 'var(--font-mono), monospace', fontWeight: 600 }}>
            {r.display_code ?? r.lot_code}
          </Link>
          {r.display_code && r.display_code !== r.lot_code && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono), monospace' }}>
              {r.lot_code}
            </span>
          )}
        </div>
      ),
    },
    { key: 'title', header: 'Description', cell: (r) => r.title ?? '—' },
    {
      key: 'loc',
      header: 'Last known location',
      // Rows are sorted per warehouse, then by location (loadMissingReport),
      // so showing the warehouse name here makes that grouping visible when
      // an operator has more than one.
      cell: (r) =>
        r.location_code ? (
          <div style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontFamily: 'var(--font-mono), monospace' }}>{r.location_code}</span>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {day(r.location_at)}
              {r.warehouse_name ? ` · ${r.warehouse_name}` : ''}
            </span>
          </div>
        ) : r.warehouse_name ? (
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{r.warehouse_name}</span>
        ) : (
          '—'
        ),
    },
    { key: 'at', header: 'Marked missing', cell: (r) => day(r.missing_at) },
    {
      key: 'reason',
      header: 'Reason',
      cell: (r) => (
        <div style={{ display: 'grid', gap: 2 }}>
          <span>{reasonText(r)}</span>
          {r.marked_by_name && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>by {r.marked_by_name}</span>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'Status',
      cell: (r) => {
        const checks = history.get(r.lot_id) ?? [];
        return (
          <div style={{ display: 'grid', gap: 4 }}>
            <span
              style={{
                fontWeight: 700,
                color: r.state === 'open' ? 'var(--danger)' : r.state === 'unsellable' ? 'var(--warning, #c90)' : 'var(--fg)',
              }}
            >
              {STATE_LABEL[r.state] ?? r.state}
            </span>
            {checks.length > 0 && (
              <details>
                <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--fg-muted)' }}>
                  {checks.length} check{checks.length === 1 ? '' : 's'}
                </summary>
                <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, display: 'grid', gap: 2 }}>
                  {checks.map((c) => (
                    <li key={c.id}>
                      {day(c.checked_at)} · {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                      {c.removal_kind && c.outcome === 'disposed' ? ` (${c.removal_kind.replace(/_/g, ' ')})` : ''}
                      {' · '}
                      {(c.checked_by && names.get(c.checked_by)) ?? 'unknown'}
                      {c.note ? ` — ${c.note}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      cell: (r) => <MissingRowActions lotId={r.lot_id} state={r.state} canManage={canManage} />,
    },
  ];

  return (
    <div>
      {/* Print: just the report. */}
      <style>{`@media print { nav, aside, header, .no-print { display: none !important; } }`}</style>
      <PageHeader
        title="Missing items"
        action={
          <div className="no-print" style={{ display: 'flex', gap: 8 }}>
            <PrintButton />
            <a href={`/reports/missing/export${all ? '?all=1' : ''}`} style={secondaryButtonStyle}>
              Download CSV
            </a>
          </div>
        }
      />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 780 }}>
        Items marked missing at pickup or removed as missing. They can&apos;t go back in an auction
        until someone finds them and puts them away. Each item stays here until it is worked:{' '}
        <strong>Found</strong> (put it away again), <strong>Confirmed missing</strong> (write it off),
        or <strong>Unsellable</strong> (mark for disposal, then record the disposal).
      </p>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '1rem',
          marginBottom: '1rem',
        }}
      >
        <KpiCard label="Still missing" value={String(openCount)} />
        <KpiCard label="Awaiting disposal" value={String(unsellableCount)} />
      </section>

      <div className="no-print" style={{ marginBottom: '1rem', fontSize: 13 }}>
        {all ? (
          <Link href="/reports/missing">Show unresolved only</Link>
        ) : (
          <Link href="/reports/missing?all=1">Show resolved too</Link>
        )}
      </div>

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
          Couldn&apos;t load missing items: {report.message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.lot_id}
        empty={all ? 'Nothing has been marked missing.' : 'No unresolved missing items.'}
      />
    </div>
  );
}
