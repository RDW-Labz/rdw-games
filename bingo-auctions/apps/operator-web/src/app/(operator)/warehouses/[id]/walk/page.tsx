// Walk-warehouse instructions page (web).
//
// Replaces the deleted /warehouses/[id]/floorplan flow. The actual walk
// happens on the field-mobile app — this page shows the operator how to
// start it, the current verified-bin count, and the bin codes ordered by
// physical walking sequence so they can plan a route.
//
// Multi-tenant note: same operator_users + warehouses.operator_id check
// as page.tsx and pickup-hours/page.tsx.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { PublishFloorPlanButton } from './PublishFloorPlanButton';

export default async function WalkInstructionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const { data: warehouse } = await supabase
    .from('warehouses')
    .select('id, name, city, state, operator_id')
    .eq('id', id)
    .single();

  if (!warehouse) notFound();
  if (
    (warehouse as { operator_id: string }).operator_id !==
    (me as { operator_id: string }).operator_id
  ) {
    notFound();
  }

  // Pull active bins with their walk-mode scanned_at, ordered by code so the
  // operator can walk a sensible route (the bin code encodes Aisle / Bay /
  // Level, so alphabetical-by-code mirrors physical layout).
  const { data: bins } = await supabase
    .from('bins')
    .select('id, code, scanned_at, coord_x_m, coord_y_m')
    .eq('warehouse_id', id)
    .is('retired_at', null)
    .order('code');

  const total = bins?.length ?? 0;
  const verified = (bins ?? []).filter(
    (b) => (b as { scanned_at: string | null }).scanned_at != null,
  ).length;
  const positioned = (bins ?? []).filter(
    (b) =>
      (b as { coord_x_m: number | null }).coord_x_m != null &&
      (b as { coord_y_m: number | null }).coord_y_m != null,
  ).length;
  const unverified = total - verified;

  return (
    <div>
      <PageHeader
        title="Walk the warehouse"
        action={
          <Link
            href={`/warehouses/${id}`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Back to setup
          </Link>
        }
      />

      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: 13,
          marginTop: -8,
          marginBottom: '1.5rem',
        }}
      >
        {warehouse.name as string} · {warehouse.city as string},{' '}
        {warehouse.state as string}
      </p>

      <div
        style={{
          padding: '1.25rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: '1.5rem',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Why walk it?</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.6 }}>
          The bin codes you already added (Aisle / Bay / Level) tell us where
          each bin <em>should</em> be on a grid map. Walking the warehouse
          with your phone and scanning each bin&apos;s printed QR confirms it
          is physically placed and lets your bidders find it in seconds.
        </p>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.6 }}>
          The walk runs entirely on the BinGo Staff app — there&apos;s
          nothing more to do here once you start.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}
      >
        <KpiCard label="Total bins" value={String(total)} />
        <KpiCard
          label="Walk-verified"
          value={`${verified} / ${total}`}
          tone={verified === total && total > 0 ? 'success' : 'default'}
        />
        <KpiCard
          label="With ARKit position"
          value={`${positioned} / ${total}`}
          sub={positioned === 0 ? 'Phase 2 (planned)' : undefined}
        />
        <KpiCard label="Unverified" value={String(unverified)} />
      </div>

      {/* Publish floor plan — shown only when every bin has been walk-verified */}
      {verified === total && total > 0 && (
        <div
          style={{
            padding: '1.25rem',
            background: 'var(--success-dim)',
            border: '1px solid var(--success)',
            borderRadius: 8,
            marginBottom: '1.5rem',
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 16, color: 'var(--success)' }}>
            All bins verified — ready to publish
          </h2>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.6, marginBottom: '1rem' }}>
            Every bin in this warehouse has been walk-scanned. Click below to
            generate a floor-plan map from the bin codes and make it visible to
            your bidders in the BinGo Auctions app.
          </p>
          <PublishFloorPlanButton warehouseId={id} />
        </div>
      )}

      <div
        style={{
          padding: '1.25rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: '1.5rem',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>How to walk it</h2>
        <ol style={{ color: 'var(--fg)', fontSize: 14, lineHeight: 1.7, paddingLeft: 20 }}>
          <li>Open <strong>BinGo Staff</strong> on your iPhone or iPad.</li>
          <li>Tap <strong>Warehouse layout</strong> on the home screen.</li>
          <li>Pick <strong>{warehouse.name as string}</strong>.</li>
          <li>
            Stand near any bin and scan its QR — that becomes your origin
            point.
          </li>
          <li>
            Walk to each remaining bin and scan its QR. You&apos;ll get a
            haptic + audio confirmation per scan; no need to look at the
            screen.
          </li>
          <li>
            Need to mark a non-bin spot (loading dock, shipping table, will-call
            counter)? Tap <strong>+ Landmark</strong> mid-walk to drop a
            named pin at your current position.
          </li>
        </ol>
      </div>

      {total > 0 ? (
        <div
          style={{
            padding: '1.25rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginBottom: '1.5rem',
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Bins to visit</h2>
          <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 12 }}>
            Sorted by code (matches your physical Aisle / Bay / Level layout).
            Verified bins show a green check; unverified show a dashed circle.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
              gap: 6,
              fontFamily: 'monospace',
              fontSize: 13,
            }}
          >
            {(bins ?? []).map((b) => {
              const bin = b as {
                id: string;
                code: string;
                scanned_at: string | null;
              };
              const ok = bin.scanned_at != null;
              return (
                <div
                  key={bin.id}
                  style={{
                    padding: '0.5rem 0.6rem',
                    borderRadius: 4,
                    background: ok ? 'var(--success-dim)' : 'transparent',
                    border: `1px ${ok ? 'solid' : 'dashed'} ${
                      ok ? 'var(--success)' : 'var(--border)'
                    }`,
                    color: ok ? 'var(--success)' : 'var(--fg-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span>{ok ? '✓' : '○'}</span>
                  <span>{bin.code}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: '1.25rem',
            border: '1px dashed var(--border)',
            borderRadius: 8,
            color: 'var(--fg-muted)',
            fontSize: 13,
          }}
        >
          No bins added yet. Go back to setup and add bins in step 1 before
          walking.
        </div>
      )}
    </div>
  );
}
