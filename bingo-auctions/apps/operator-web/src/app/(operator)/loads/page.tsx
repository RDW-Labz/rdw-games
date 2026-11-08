// Loads list — every truck/pallet the operator has tracked, most-recent first.
//
// Per PLAN-field-mobile-restructure-2026-05-25.md W9 slice 3:
//   - Combined list of auto-import (one-per-imports-row) + manual loads
//   - Filter chips: All / Auto-import / Manual / Archived
//   - Lot count column (via loads_with_lot_counts RPC)
//   - "+ New manual load" CTA for admin/manager only
//   - Archive button per row (admin/manager only)
//
// Field-mobile reads this same table; only the web has write surfaces.
// (Resolved decision D8 — managers control loads.)

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader } from '@/components/Form';
import { DataTable, FilterPills, type Column } from '@/components/console';
import { ArchiveLoadButton } from './ArchiveLoadButton';
import { LoadCostEditor } from './LoadCostEditor';

type LoadType = 'auto-import' | 'manual';
type Filter = 'all' | 'auto-import' | 'manual' | 'archived';

type LoadRow = {
  id: string;
  type: LoadType;
  source_name: string;
  purchase_cost_cents: number | null;
  purchase_date: string | null;
  notes: string | null;
  import_id: string | null;
  created_at: string;
  archived_at: string | null;
};

function asFilter(value: string | string[] | undefined): Filter {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === 'auto-import' || v === 'manual' || v === 'archived') return v;
  return 'all';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // Date-only (YYYY-MM-DD) — render as a calendar date, not local TZ-shifted.
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Load-type badge, tokens only (was #3b82f6 blue / #a855f7 purple). Auto-import
// = cyan (derived/info), manual = neutral (hand-entered).
const typeBadgeStyle = (type: LoadType): React.CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  background: type === 'auto-import' ? 'var(--cyan-dim)' : 'var(--bg-elev-2)',
  color: type === 'auto-import' ? 'var(--cyan-hi)' : 'var(--fg-dim)',
});

export default async function LoadsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const role = (me as { role: string }).role;
  const canEdit = role === 'admin' || role === 'manager';
  const canWrite = canEdit;

  const params = await searchParams;
  const filter = asFilter(params.type);

  // Build query with filter
  let query = supabase
    .from('loads')
    .select(
      'id, type, source_name, purchase_cost_cents, purchase_date, notes, import_id, created_at, archived_at',
    )
    .order('created_at', { ascending: false })
    .limit(200);

  if (filter === 'archived') {
    query = query.not('archived_at', 'is', null);
  } else if (filter === 'auto-import' || filter === 'manual') {
    query = query.is('archived_at', null).eq('type', filter);
  } else {
    query = query.is('archived_at', null);
  }

  const { data: loadsData } = await query;
  const loads = (loadsData ?? []) as LoadRow[];

  // Lot counts per load via helper RPC (RLS scopes to operator).
  const { data: countsData } = await supabase.rpc('loads_with_lot_counts');
  const lotCounts = new Map<string, number>();
  for (const row of (countsData ?? []) as { load_id: string; lot_count: number }[]) {
    lotCounts.set(row.load_id, row.lot_count);
  }

  const emptyText =
    filter === 'archived'
      ? 'No archived loads.'
      : canWrite
        ? 'No loads yet. Click + New manual load or import a manifest to get started.'
        : 'No loads yet. A manager will create them.';

  const columns: Column<LoadRow>[] = [
    {
      key: 'source',
      header: 'Source',
      cell: (l) => (
        <div style={{ overflow: 'hidden' }}>
          <Link
            href={`/loads/${l.id}`}
            style={{
              color: 'var(--fg)',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: 'none',
              display: 'block',
            }}
          >
            {l.source_name}
          </Link>
          {l.notes && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {l.notes}
            </div>
          )}
          {l.import_id && (
            <Link
              href={`/imports/${l.import_id}`}
              style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2, textDecoration: 'none' }}
            >
              View source import →
            </Link>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: 100,
      cell: (l) => (
        <span style={typeBadgeStyle(l.type)}>
          {l.type === 'auto-import' ? 'IMPORT' : 'MANUAL'}
        </span>
      ),
    },
    {
      key: 'lots',
      header: 'Lots',
      numeric: true,
      width: 80,
      cell: (l) => <span style={{ fontWeight: 700 }}>{lotCounts.get(l.id) ?? 0}</span>,
    },
    {
      key: 'cost',
      header: 'Cost',
      numeric: true,
      width: 120,
      cell: (l) => (
        <LoadCostEditor
          loadId={l.id}
          costCents={l.purchase_cost_cents}
          canEdit={canEdit}
        />
      ),
    },
    {
      key: 'purchased',
      header: 'Purchased',
      width: 120,
      cell: (l) => (
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{formatDate(l.purchase_date)}</span>
      ),
    },
    {
      key: 'added',
      header: 'Added',
      width: 140,
      cell: (l) => (
        // TODO(tz): loads has no warehouse_id, so there is no warehouse zone to
        // resolve. Date-only render of created_at left in the SSR runtime zone
        // (purchase_date above is a calendar-anchored date string and is
        // intentionally not zone-shifted).
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          {new Date(l.created_at).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </span>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      width: 100,
      cell: (l) =>
        canWrite && !l.archived_at ? (
          <ArchiveLoadButton loadId={l.id} sourceName={l.source_name} />
        ) : l.archived_at ? (
          <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>archived</span>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Loads"
        action={
          canWrite ? (
            <Link href="/loads/new" className="btn-primary">
              + New manual load
            </Link>
          ) : null
        }
      />
      <p
        style={{
          color: 'var(--fg-muted)',
          maxWidth: 720,
          lineHeight: 1.5,
          marginBottom: 16,
        }}
      >
        Loads are trucks, pallets, or programs you&apos;ve bought. Auto-import
        rows come from your manifest uploads. Manual rows let you track
        unmanifested trucks. Each lot can link to a load for profit tracking.
      </p>

      <FilterPills
        aria-label="Filter loads"
        active={filter}
        style={{ marginBottom: 16 }}
        options={[
          { value: 'all', label: 'All', href: '/loads' },
          { value: 'auto-import', label: 'From import', href: '/loads?type=auto-import' },
          { value: 'manual', label: 'Manual', href: '/loads?type=manual' },
          { value: 'archived', label: 'Archived', href: '/loads?type=archived' },
        ]}
      />

      <DataTable
        columns={columns}
        rows={loads}
        rowKey={(l) => l.id}
        rowStyle={(l) => (l.archived_at ? { opacity: 0.55 } : undefined)}
        empty={emptyText}
        style={{ maxWidth: 1200 }}
      />
    </div>
  );
}
