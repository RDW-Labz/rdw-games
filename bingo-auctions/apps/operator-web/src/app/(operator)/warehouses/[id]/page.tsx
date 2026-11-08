// Warehouse setup hub — replaces the 3-link row with a stepper that surfaces
// completion state for each chunk of warehouse configuration.
//
// Five steps (post-2026-05-21 walk-mode rework):
//   1. Bins — at least one bin exists
//   2. QR labels — soft step (we don't track print date in v1; the action
//      stays clickable but never goes "done")
//   3. Walk warehouse — operator opens the field-mobile app and physically
//      walks the space, scanning each bin QR. Migration 0102 stamps
//      bins.scanned_at; this step's progress comes from the
//      walk_progress_per_warehouse view.
//   4. Pickup hours — pickup_hours JSONB has at least one day with a window
//   5. Pickup mode — explicit choice persisted (defaults to 'staff_assisted')
//
// Removed in this rework (2026-05-21):
//   * "Floor plan" step — uploading a PNG/SVG and dragging bins onto it was
//     a desktop mental model that didn't survive mobile. Bins are now
//     positioned by walking the warehouse with the phone.
//   * "Position bins" step — see above. The walk-mode flow generates
//     positions from the bin codes (idealized grid) or ARKit (absolute
//     meters); operator never drags chips on a canvas again.
//
// Multi-tenant note: operator scope enforced via the operator_users + warehouses
// operator_id check at the top, same pattern as pickup-hours/page.tsx.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { isWarehouseActive } from '@/lib/warehouse-active';
import { WarehouseHubV2 } from './v2/WarehouseHubV2';

type StepState = 'done' | 'partial' | 'todo';

type Step = {
  title: string;
  detail: string;
  href: string;
  state: StepState;
};

const PICKUP_MODE_LABEL: Record<string, string> = {
  staff_assisted: 'Staff-assisted (staff retrieves; bidder shows QR)',
  counter_pickup: 'Counter pickup (bidder walks aisles, finds lots on shelves)',
  self_serve_floor_plan: 'Self-serve with floor plan (bidder uses map to find bins)',
  hybrid: 'Hybrid (configurable per auction)',
  // Legacy value — remapped to counter_pickup by migration 0165. Kept here
  // as a display fallback for any row that hasn't been migrated yet.
  self_serve: 'Customer pickup (legacy — see counter_pickup)',
};

export default async function WarehouseHubPage({
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
    .select('*')
    .eq('id', id)
    .single();

  if (!warehouse) notFound();
  if ((warehouse as { operator_id: string }).operator_id !== (me as { operator_id: string }).operator_id) {
    notFound();
  }

  // Bin counts — total active and total verified via walk-mode (post-0102).
  const { count: binCount } = await supabase
    .from('bins')
    .select('id', { count: 'exact', head: true })
    .eq('warehouse_id', id)
    .is('retired_at', null);

  // Walk-mode verified bins — migration 0102 added bins.scanned_at, populated
  // by the field-mobile walk flow when the operator physically scans each
  // bin QR. Falls back gracefully when scanned_at is missing (pre-0102 prod).
  const { count: verifiedCount } = await supabase
    .from('bins')
    .select('id', { count: 'exact', head: true })
    .eq('warehouse_id', id)
    .is('retired_at', null)
    .not('scanned_at', 'is', null);

  const totalBins = binCount ?? 0;
  const verifiedBins = verifiedCount ?? 0;

  const pickupHours = (warehouse.pickup_hours ?? {}) as Record<string, Array<{ open: string; close: string }>>;
  const daysWithHours = Object.values(pickupHours).filter(
    (windows) => Array.isArray(windows) && windows.length > 0,
  ).length;
  const slotMinutes = (warehouse.pickup_slot_minutes as number | null) ?? null;
  const slotCapacity = (warehouse.pickup_slot_capacity as number | null) ?? null;

  const pickupMode = (warehouse.pickup_mode as string | null) ?? 'staff_assisted';
  const floorPlanUrl = (warehouse.floor_plan_url as string | null) ?? null;
  const pickupInstructions = (warehouse as { pickup_instructions?: string | null }).pickup_instructions;
  const customerNotice = (warehouse as { customer_notice?: string | null }).customer_notice;
  const warehouseActive = isWarehouseActive(warehouse as { active?: boolean | null });
  const hasCustomerInfo = Boolean(pickupInstructions?.trim() || customerNotice?.trim());

  const steps: Step[] = [
    {
      title: 'Bins',
      detail: totalBins > 0 ? `${totalBins} bin${totalBins === 1 ? '' : 's'} added` : 'No bins yet',
      href: `/warehouses/${id}/bins`,
      state: totalBins > 0 ? 'done' : 'todo',
    },
    {
      title: 'QR labels',
      detail: totalBins > 0 ? `${totalBins} label${totalBins === 1 ? '' : 's'} ready to print` : 'Add bins first',
      // Deep-link to the Bins page (its toolbar offers per-bin / selective
      // printing: Selected / Filtered / By aisle / By section / Unverified,
      // plus a "Print everything" escape hatch) rather than the print-ALL
      // GET endpoint (/api/warehouses/${id}/qr-sheet). Testers relied on
      // printing individual bin labels; linking straight to the all-bins PDF
      // regressed that. The Bins page restores the selective print UX.
      href: `/warehouses/${id}/bins`,
      // Not auto-tracked in v1; the operator decides when they've physically
      // printed + posted the labels. Show 'partial' once bins exist so the
      // step is actionable but never claims completion without operator
      // intent.
      state: totalBins === 0 ? 'todo' : 'partial',
    },
    {
      // Replaces the old "Floor plan" + "Position bins" steps (deleted
      // 2026-05-21). Progress sourced from bins.scanned_at populated by
      // the field-mobile walk-and-scan flow (see migration 0102).
      title: 'Walk warehouse',
      detail:
        totalBins === 0
          ? 'Add bins first'
          : verifiedBins === 0
            ? 'Open BinGo Staff on your phone to begin the walk'
            : verifiedBins === totalBins
              ? `All ${totalBins} bins verified on the walk`
              : `${verifiedBins} of ${totalBins} bins walk-verified`,
      href: `/warehouses/${id}/walk`,
      state:
        totalBins === 0
          ? 'todo'
          : verifiedBins === 0
            ? 'todo'
            : verifiedBins === totalBins
              ? 'done'
              : 'partial',
    },
    {
      title: 'Pickup hours',
      detail: daysWithHours > 0
        ? `${daysWithHours} day${daysWithHours === 1 ? '' : 's'} open · ${slotMinutes ?? 30}-min slots · cap ${slotCapacity ?? 5}`
        : 'No hours configured',
      href: `/warehouses/${id}/pickup-hours`,
      state: daysWithHours > 0 ? 'done' : 'todo',
    },
    {
      title: 'Pickup mode',
      detail: PICKUP_MODE_LABEL[pickupMode] ?? `Unknown mode (${pickupMode})`,
      href: `/warehouses/${id}/pickup-mode`,
      // 'partial' when self_serve_floor_plan is selected but floor plan hasn't
      // been published yet — that's the "Map not ready" failure mode (S7c fix).
      // All other modes are always 'done' (mode is NOT NULL with a default).
      state: pickupMode === 'self_serve_floor_plan' && !floorPlanUrl ? 'partial' : 'done',
    },
    {
      title: 'Customer info',
      detail: hasCustomerInfo
        ? 'Pickup instructions or customer notice configured'
        : warehouseActive
          ? 'Optional pickup copy and off-site notice'
          : 'Warehouse marked inactive',
      href: `/warehouses/${id}/customer-info`,
      state: hasCustomerInfo ? 'done' : 'partial',
    },
  ];

  const completedCount = steps.filter((s) => s.state === 'done').length;
  const todoCount = steps.filter((s) => s.state === 'todo').length;

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    return (
      <WarehouseHubV2
        warehouseId={id}
        title={`${warehouse.name as string}${warehouseActive ? '' : ' — Inactive'}`}
        locationLine={`${warehouse.city as string}, ${warehouse.state as string}`}
        completedCount={completedCount}
        totalSteps={steps.length}
        todoCount={todoCount}
        steps={steps}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title={`${warehouse.name as string}${warehouseActive ? '' : ' — Inactive'}`}
        action={
          <Link href="/warehouses" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            ← All warehouses
          </Link>
        }
      />

      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        {warehouse.city as string}, {warehouse.state as string} ·{' '}
        <strong style={{ color: completedCount === steps.length ? 'var(--success, #4ade80)' : 'var(--fg)' }}>
          {completedCount}/{steps.length} steps complete
        </strong>
        {todoCount > 0 ? ` · ${todoCount} remaining` : ''}
      </p>

      <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
        {steps.map((step, idx) => (
          <li
            key={step.title}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '1rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderLeft: `4px solid ${stateColor(step.state)}`,
              borderRadius: 6,
            }}
          >
            <StepIcon state={step.state} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Step {idx + 1} — {step.title}
              </div>
              <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 2 }}>{step.detail}</div>
            </div>
            <Link
              href={step.href}
              {...(step.href.startsWith('/api/') ? { target: '_blank', rel: 'noreferrer' as const } : {})}
              style={{ ...secondaryButtonStyle, textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              {step.state === 'done' ? 'Edit →' : step.state === 'partial' ? 'Continue →' : 'Start →'}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

function stateColor(s: StepState): string {
  if (s === 'done') return 'var(--success, #4ade80)';
  if (s === 'partial') return 'var(--warning, #fbbf24)';
  return 'var(--border)';
}

function StepIcon({ state }: { state: StepState }) {
  const color = stateColor(state);
  if (state === 'done') {
    return (
      <span
        aria-label="complete"
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: color,
          color: '#0b0d12',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    );
  }
  if (state === 'partial') {
    return (
      <span
        aria-label="in progress"
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          background: 'transparent',
          color: color,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ◐
      </span>
    );
  }
  return (
    <span
      aria-label="not started"
      style={{
        width: 24,
        height: 24,
        borderRadius: '50%',
        border: `2px dashed var(--border)`,
        flexShrink: 0,
      }}
    />
  );
}
