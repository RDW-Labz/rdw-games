// Bin management for a warehouse.
// - Bulk add + single add via BinForm
// - Per-row edit + retire / restore via BinsTable (client component)
// - Print QR sheet via the api route
//
// retired_at (migration 0094) is the canonical lifecycle. Retired bins
// are hidden by default but the operator can toggle them back into view.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { BinForm } from './BinForm';
import { BinsTable, type BinRow } from './BinsTable';

export default async function BinsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const { data: warehouse } = await supabase
    .from('warehouses')
    .select('id, name, floor_plan_width_px, floor_plan_height_px')
    .eq('id', id)
    .single();

  if (!warehouse) notFound();

  const { data: bins } = await supabase
    .from('bins')
    // 0102 added scanned_at (walk-mode verification). 0108 added section.
    // Both are surfaced so BinsTable can show status and offer scoped prints.
    .select(
      'id, code, aisle, bay, level, position, section, x_px, y_px, retired_at, scanned_at',
    )
    .eq('warehouse_id', id)
    .order('code');

  return (
    <div>
      <PageHeader
        title={`Bins — ${warehouse.name}`}
        action={
          // Print controls live in the BinsTable toolbar below so they can
          // scope by selection / aisle / section / verified. The header
          // only carries cross-page navigation now.
          <Link
            href={`/warehouses/${id}`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Setup
          </Link>
        }
      />

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Add bins</h2>
        <BinForm warehouseId={id} />
      </section>

      <section>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Existing bins</h2>
        <BinsTable warehouseId={id} bins={(bins ?? []) as BinRow[]} />
      </section>
    </div>
  );
}
