// Manifest pool detail — the rows from one CSV import.
//
// Architectural note (migration 0059):
//   This page is a view of *expected* items. The only mutation here is
//   "Drop" (mark a row as not-sellable). Lots come into existence at
//   physical intake — when a picker scans the item plus a bin QR, the
//   matching pending manifest row flips to 'lotted' and a real lot
//   appears in /lotting/inventory at status='in_inventory'.
//
// Already-lotted and already-dropped rows show as history (greyed out, no
// checkbox). The page server-renders the full manifest; bulk drop actions
// happen on the client.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { ManifestPool } from './ManifestPool';

type ImportRowDB = {
  id: string;
  title: string;
  description: string | null;
  category_raw: string | null;
  upc: string | null;
  external_code: string | null;
  msrp_cents: number | null;
  starting_bid_cents: number | null;
  photo_url: string | null;
  condition: string | null;
  status: 'pending' | 'lotted' | 'dropped';
  lot_id: string | null;
  lotted_at: string | null;
  dropped_at: string | null;
  dropped_reason: string | null;
  created_at: string;
};

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const { data: imp } = await supabase
    .from('imports')
    .select('id, filename, source_label, status, error, row_count, classified_count, created_at')
    .eq('id', id)
    .eq('operator_id', me.operator_id as string)
    .maybeSingle();
  if (!imp) notFound();

  const { data: rowsData } = await supabase
    .from('import_rows')
    .select(
      'id, title, description, category_raw, upc, external_code, msrp_cents, starting_bid_cents, photo_url, condition, status, lot_id, lotted_at, dropped_at, dropped_reason, created_at',
    )
    .eq('import_id', id)
    .order('status', { ascending: true })       // pending first
    .order('created_at', { ascending: true });
  const rows = (rowsData ?? []) as ImportRowDB[];

  const counts = {
    pending: rows.filter((r) => r.status === 'pending').length,
    lotted: rows.filter((r) => r.status === 'lotted').length,
    dropped: rows.filter((r) => r.status === 'dropped').length,
  };

  return (
    <div>
      <PageHeader
        title={imp.filename}
        action={
          <Link
            href="/imports"
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Imports
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', maxWidth: 720, lineHeight: 1.5, marginBottom: 12 }}>
        Expected items from {imp.filename}. When the truck arrives, pickers
        scan each item&apos;s UPC / ASIN / FNSKU / LPN against a bin QR in
        the field-mobile app — that mints a lot code, copies all identity
        and source fields onto the new lot, and lands it in
        <strong> Inventory</strong> at status <code>in_inventory</code> in
        one step. <strong>No premature lot codes are burned</strong>:
        manifest rows that never arrive stay <code>pending</code> here as
        history; rows that turn out unsellable can be marked
        <code>dropped</code> below.
      </p>

      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <KpiCard label="Pending" value={counts.pending.toLocaleString()} tone="accent" />
        <KpiCard label="Lotted" value={counts.lotted.toLocaleString()} tone="success" />
        <KpiCard label="Dropped" value={counts.dropped.toLocaleString()} muted />
        <KpiCard label="Total" value={rows.length.toLocaleString()} />
      </div>

      <ManifestPool importId={imp.id} initialRows={rows} />
    </div>
  );
}

