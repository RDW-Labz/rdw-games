// Pickup-mode chooser. Three radio choices that map to the database
// `pickup_mode` column on warehouses (added in migration 0094). The
// effective mode for an auction is COALESCE(auction.pickup_mode_override,
// warehouse.pickup_mode) — auction overrides aren't UI-exposed yet (Phase 3+).

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { PickupModeForm } from './PickupModeForm';
import type { PickupMode } from './actions';
import { WarehouseFormPageV2 } from '../v2/WarehouseFormPageV2';

const OPTIONS: Array<{
  value: PickupMode;
  title: string;
  blurb: string;
  bestFor: string;
  floorPlanNote?: string;
}> = [
  {
    value: 'counter_pickup',
    title: 'Counter pickup (shelf retrieval)',
    blurb:
      'Customers walk the aisles, find lots on labeled shelves, bring them to the counter. Staff scan the QR code at checkout. No floor-plan map shown — bidders see lot codes and bin locations.',
    bestFor:
      'Best for: most auction operators. Items are sorted onto shelves by lot code; bidders retrieve their own and present at the counter.',
  },
  {
    value: 'staff_assisted',
    title: 'Staff-assisted pickup',
    blurb:
      'Staff retrieves items; customer shows QR at the counter. Bidders never enter the warehouse floor — they arrive, scan, and staff bring the staged lots to them.',
    bestFor:
      'Best for: high-value items, smaller warehouse, operators who want zero bidder foot traffic on the floor.',
  },
  {
    value: 'self_serve_floor_plan',
    title: 'Self-serve with floor plan',
    blurb:
      'Customers use an interactive warehouse map to navigate to each of their bins, check off items as they collect them, then tap "Confirm pickup." Requires a published floor plan.',
    bestFor:
      'Best for: large open-floor warehouses (BidFTA-style) once a floor plan has been generated from your scanned bins.',
    floorPlanNote:
      'Requires a published floor plan. Use the Walk warehouse step to scan bins, then generate the floor plan from the warehouse hub.',
  },
  {
    value: 'hybrid',
    title: 'Hybrid (configure per auction)',
    blurb:
      'Default mode applies warehouse-wide, but individual auctions can override. Useful when most sales use one mode but you occasionally run the other.',
    bestFor:
      'Advanced. Not required for launch — start with one mode and add hybrid only if you actually need it.',
  },
];

export default async function PickupModePage({
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

  if (!['admin', 'manager'].includes((me as { role: string }).role)) {
    const cookieStoreDenied = await cookies();
    if (isConsoleV2(cookieStoreDenied.get(CONSOLE_UI_COOKIE)?.value)) {
      return (
        <WarehouseFormPageV2 title="Pickup mode" backHref={`/warehouses/${id}`} backLabel="← Setup overview">
          <p style={{ color: 'var(--fg-muted)' }}>Admin or manager access required.</p>
        </WarehouseFormPageV2>
      );
    }
    return (
      <div>
        <PageHeader title="Pickup mode" />
        <p style={{ color: 'var(--fg-muted)' }}>Admin or manager access required.</p>
      </div>
    );
  }

  const { data: warehouse } = await supabase
    .from('warehouses')
    .select('id, name, operator_id, pickup_mode')
    .eq('id', id)
    .single();

  if (!warehouse) notFound();
  if ((warehouse as { operator_id: string }).operator_id !== (me as { operator_id: string }).operator_id) {
    notFound();
  }

  const current = ((warehouse as { pickup_mode: string | null }).pickup_mode ?? 'staff_assisted') as PickupMode;

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    // mirrors the v1 intro paragraph below — keep in sync
    const modeIntro =
      'Determines how bidders collect their items after paying. Switching modes does not affect lots already paid for — only future invoices.';
    return (
      <WarehouseFormPageV2
        title={`${warehouse.name as string} — Pickup mode`}
        backHref={`/warehouses/${id}`}
        backLabel="← Setup overview"
        intro={modeIntro}
      >
        <PickupModeForm warehouseId={id} initialMode={current} options={OPTIONS} />
      </WarehouseFormPageV2>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${warehouse.name as string} — Pickup mode`}
        action={
          <Link
            href={`/warehouses/${id}`}
            style={{ ...secondaryButtonStyle, textDecoration: 'none' }}
          >
            ← Setup overview
          </Link>
        }
      />

      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        Determines how bidders collect their items after paying. Switching modes
        does not affect lots already paid for — only future invoices.
      </p>

      <PickupModeForm warehouseId={id} initialMode={current} options={OPTIONS} />
    </div>
  );
}
